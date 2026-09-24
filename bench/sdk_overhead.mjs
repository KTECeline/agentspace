// AgentSpace TypeScript SDK overhead benchmark (no dependencies).
//
// Per-call latency of emit(), a step() scope and an agent() scope (p50/p99/max) with the collector
// up, down (connection refused) and stalled (accepts, never answers), plus the SDK disabled as a
// baseline; event-loop delay (perf_hooks) while emitting; heap growth after 200,000 events with
// the collector down.
//
// Reproduce:
//   pnpm --filter agentspace-sdk build && node bench/sdk_overhead.mjs
// Writes bench/results/sdk-ts.json and prints a Markdown table.
import { fork } from "node:child_process";
import { createServer as createHttp } from "node:http";
import { createServer as createTcp } from "node:net";
import { writeFileSync, mkdirSync } from "node:fs";
import { cpus, totalmem, type as osType, release } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const N = 50_000;
const WARMUP = 2_000;

// ---------------------------------------------------------------- stub collectors (child processes)

if (process.argv[2] === "--stub") {
  const kind = process.argv[3];
  if (kind === "up") {
    const srv = createHttp((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const n = req.method === "POST" ? (JSON.parse(body || "{}").events?.length ?? 0) : 0;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(req.method === "POST" ? JSON.stringify({ accepted: n, duplicates: 0, rejected: 0, errors: [] }) : "{}");
      });
    });
    srv.listen(0, "127.0.0.1", () => process.send({ port: srv.address().port }));
  } else {
    const held = [];
    const srv = createTcp((sock) => held.push(sock)); // accept, never answer
    srv.listen(0, "127.0.0.1", () => process.send({ port: srv.address().port }));
  }
} else {
  await main();
}

function stub(kind) {
  return new Promise((resolve) => {
    const child = fork(fileURLToPath(import.meta.url), ["--stub", kind], { stdio: "ignore" });
    child.once("message", ({ port }) => resolve({ url: `http://127.0.0.1:${port}`, stop: () => child.kill() }));
  });
}

function refusedUrl() {
  return new Promise((resolve) => {
    const srv = createTcp();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(`http://127.0.0.1:${port}`)); // nothing listens here now
    });
  });
}

// ---------------------------------------------------------------- measurement

function pct(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * sorted.length) - 1))];
}

function timed(fn) {
  for (let i = 0; i < WARMUP; i++) fn();
  const samples = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    samples[i] = Number(process.hrtime.bigint() - t0) / 1000; // µs
  }
  samples.sort();
  const r = (x) => Math.round(x * 100) / 100;
  return { p50_us: r(pct(samples, 50)), p99_us: r(pct(samples, 99)), max_us: r(samples[N - 1]) };
}

async function scenario(as, url) {
  as.init(url === null ? { enabled: false } : { url, workspace: "bench" });
  const out = {};
  as.run("bench", () =>
    as.agent("bench", () => {
      out.emit = timed(() => as.emit("agent.status", { status: "thinking" }));
      out["step (2 events)"] = timed(() => as.step("bench step", () => {}));
      out["agent scope"] = timed(() => as.agent("bench-agent", () => {}));
    }),
  );
  out.transport = as.stats();
  await as.shutdown(500);
  return out;
}

async function loopDelay(as, url, { events = 20_000, rate = null } = {}) {
  as.init(url === null ? { enabled: false } : { url, workspace: "bench" });
  const h = monitorEventLoopDelay({ resolution: 1 });
  h.enable();
  await as.run("bench-async", () =>
    as.agent("bench", async () => {
      for (let i = 0; i < events; i++) {
        as.emit("agent.status", { status: "thinking" });
        if (rate) await new Promise((r) => setTimeout(r, 1000 / rate));
        else if (i % 100 === 99) await new Promise((r) => setImmediate(r));
      }
    }),
  );
  h.disable();
  await as.shutdown(500);
  const ms = (ns) => Math.round((ns / 1e6) * 100) / 100;
  return { p50_ms: ms(h.percentile(50)), p99_ms: ms(h.percentile(99)), max_ms: ms(h.max) };
}

async function heapWhenDown(as, events = 200_000) {
  as.init({ url: await refusedUrl(), workspace: "bench" });
  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  as.run("bench-mem", () => as.agent("bench", () => {
    for (let i = 0; i < events; i++) as.emit("agent.status", { status: "thinking" });
  }));
  global.gc?.();
  const after = process.memoryUsage().heapUsed;
  const s = as.stats();
  await as.shutdown(200);
  return { events, heap_growth_mb: Math.round(((after - before) / 1e6) * 10) / 10, dropped: s.dropped, pending: s.pending, gc_exposed: typeof global.gc === "function" };
}

async function main() {
  const as = await import(new URL("../packages/sdk-ts/dist/index.js", import.meta.url).href);
  const up = await stub("up");
  const stalled = await stub("stalled");
  const scenarios = {
    "disabled (baseline)": null,
    "collector up": up.url,
    "collector down": await refusedUrl(),
    "collector stalled": stalled.url,
  };
  const cpu = cpus()[0]?.model ?? "?";
  const results = {
    when: new Date().toISOString(),
    command: "pnpm --filter agentspace-sdk build && node --expose-gc bench/sdk_overhead.mjs",
    machine: { cpu, cores: String(cpus().length), memory_gb: String(Math.round(totalmem() / 2 ** 30)), os: `${osType()} ${release()}`, node: process.version },
    calls_per_op: N,
    latency: {},
    event_loop: {},
  };
  for (const [name, url] of Object.entries(scenarios)) {
    process.stderr.write(`latency: ${name} ...\n`);
    results.latency[name] = await scenario(as, url);
  }
  for (const name of ["disabled (baseline)", "collector up", "collector stalled"]) {
    process.stderr.write(`event loop: ${name} ...\n`);
    results.event_loop[`${name}, 20k events flat out`] = await loopDelay(as, scenarios[name]);
    results.event_loop[`${name}, 1,000 events/s for 3 s`] = await loopDelay(as, scenarios[name], { events: 3_000, rate: 1_000 });
  }
  process.stderr.write("heap with the collector down ...\n");
  results.memory_down = await heapWhenDown(as);
  up.stop();
  stalled.stop();

  mkdirSync(here + "results", { recursive: true });
  writeFileSync(here + "results/sdk-ts.json", JSON.stringify(results, null, 1) + "\n");

  const m = results.machine;
  console.log(`\nTypeScript SDK overhead: ${m.cpu}, ${m.cores} cores, ${m.memory_gb} GB, ${m.os}, Node ${m.node}\n`);
  console.log("| Collector | Call | p50 | p99 | max |\n|---|---|---|---|---|");
  for (const [name, ops] of Object.entries(results.latency)) {
    for (const [op, r] of Object.entries(ops)) {
      if (op !== "transport") console.log(`| ${name} | \`${op}\` | ${r.p50_us} µs | ${r.p99_us} µs | ${r.max_us} µs |`);
    }
  }
  console.log("\n| Event-loop delay while emitting | p50 | p99 | max |\n|---|---|---|---|");
  for (const [name, r] of Object.entries(results.event_loop)) console.log(`| ${name} | ${r.p50_ms} ms | ${r.p99_ms} ms | ${r.max_ms} ms |`);
  const md = results.memory_down;
  console.log(`\nHeap, collector down, ${md.events.toLocaleString()} events: +${md.heap_growth_mb} MB, ${md.dropped.toLocaleString()} oldest dropped, ${md.pending.toLocaleString()} buffered.`);
  process.exit(0);
}
