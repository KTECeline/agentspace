import type { WsServerMessage } from "@agentspace/spec-types";
import type { Connection } from "../store";

export interface Sink {
  send: (msg: WsServerMessage) => void;
  setConnection: (c: Connection) => void;
}

/** Starts streaming into the sink; returns a stop function. */
export type Source = (sink: Sink) => () => void;
