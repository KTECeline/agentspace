/**
 * Office auto-layout. Pure and deterministic.
 *
 * Every team gets one or more fixed-size room "slots" on a grid. A slot holds up to
 * DESKS_PER_ROOM desks in facing pairs. Slots and desks are handed out in the order agents
 * first appeared, so adding agents or teams never moves an existing desk. That matters,
 * because people learn where "their" agents sit.
 */

export const DESKS_PER_ROOM = 8;
export const ROOM_COLUMNS = 3;
export const ROOM_W = 9;
export const ROOM_D = 7;
export const ROOM_GAP = 1.5;
const DESK_PITCH_X = 2;
const DESK_OFFSET_Z = 1.1;

export interface LayoutAgent {
  agent_id: string;
  team_id: string | null;
}

export interface Room {
  key: string; // team id + overflow index
  teamId: string;
  /** 0 for the team's first room, 1+ for overflow rooms. */
  part: number;
  x: number; // center
  z: number;
  width: number;
  depth: number;
}

export interface Desk {
  agentId: string;
  roomKey: string;
  x: number;
  z: number;
  /** Rotation around Y so the seated avatar faces its desk. */
  rotationY: number;
}

export interface OfficeLayout {
  rooms: Room[];
  desks: Record<string, Desk>;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

export function layoutOffice(agents: LayoutAgent[], firstSeen: Record<string, number>): OfficeLayout {
  const ordered = [...agents].sort(
    (a, b) => (firstSeen[a.agent_id] ?? Infinity) - (firstSeen[b.agent_id] ?? Infinity) || a.agent_id.localeCompare(b.agent_id),
  );

  const rooms: Room[] = [];
  const desks: Record<string, Desk> = {};
  const teamSeats = new Map<string, number>(); // desks used per team so far
  const teamRooms = new Map<string, Room[]>();

  for (const agent of ordered) {
    const teamId = agent.team_id ?? "";
    const seat = teamSeats.get(teamId) ?? 0;
    teamSeats.set(teamId, seat + 1);
    const part = Math.floor(seat / DESKS_PER_ROOM);
    const list = teamRooms.get(teamId) ?? [];
    let room = list[part];
    if (!room) {
      const slot = rooms.length;
      const col = slot % ROOM_COLUMNS;
      const row = Math.floor(slot / ROOM_COLUMNS);
      room = {
        key: part === 0 ? teamId || "_none" : `${teamId || "_none"}#${part}`,
        teamId,
        part,
        x: col * (ROOM_W + ROOM_GAP),
        z: row * (ROOM_D + ROOM_GAP),
        width: ROOM_W,
        depth: ROOM_D,
      };
      rooms.push(room);
      list.push(room);
      teamRooms.set(teamId, list);
    }
    desks[agent.agent_id] = deskInRoom(room, seat % DESKS_PER_ROOM, agent.agent_id);
  }

  return { rooms, desks, bounds: boundsOf(rooms) };
}

/** Desks fill in facing pairs: seat 0 faces seat 1 across the pod, then the next pair to the right. */
function deskInRoom(room: Room, index: number, agentId: string): Desk {
  const pair = Math.floor(index / 2);
  const north = index % 2 === 0;
  const pairs = DESKS_PER_ROOM / 2;
  const x = room.x + (pair - (pairs - 1) / 2) * DESK_PITCH_X;
  const z = room.z + (north ? -DESK_OFFSET_Z : DESK_OFFSET_Z) + 0.4; // leave space for the room label at the back
  return { agentId, roomKey: room.key, x, z, rotationY: north ? 0 : Math.PI };
}

function boundsOf(rooms: Room[]) {
  if (!rooms.length) return { minX: -ROOM_W / 2, maxX: ROOM_W / 2, minZ: -ROOM_D / 2, maxZ: ROOM_D / 2 };
  return {
    minX: Math.min(...rooms.map((r) => r.x - r.width / 2)),
    maxX: Math.max(...rooms.map((r) => r.x + r.width / 2)),
    minZ: Math.min(...rooms.map((r) => r.z - r.depth / 2)),
    maxZ: Math.max(...rooms.map((r) => r.z + r.depth / 2)),
  };
}
