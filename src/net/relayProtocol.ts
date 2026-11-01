import type { BattleConfig, Side } from '@/shared/types';
import type { CommandBody } from '@/sim/commands';
import type { Envelope } from './integrity';

export const RELAY_PROTOCOL = 1;
export const ROOM_TTL_MS = 15 * 60 * 1000;
export const MAX_WIRE_BYTES = 8 * 1024 * 1024;
export const MAX_ROOM_HISTORY_BYTES = 8 * 1024 * 1024;
export const SIDES: readonly Side[] = ['german', 'soviet'];
export interface RoomSettings {
  mapId: string; year: number; durationS: number; seed: number; points: number;
}
export interface RoomMember { connected: boolean; ready: boolean; forces: string[]; turn: number; sealedTo:number }
export interface RoomView {
  code: string; host: Side; settings: RoomSettings;
  phase: 'lobby' | 'playing' | 'recovering' | 'closed';
  members: Record<Side, RoomMember | null>;
  generation: number;
}
/** Only nonempty sealed bundles are retained; absence below sealedTo means empty. */
export interface TurnHistory {
  turn: number;
  sealedTo: Record<Side, number>;
  bundles: Record<Side, [number, CommandBody[]][]>;
}
export type ClientFrame =
  | { op: 'create'; protocol: number; build: string; side: Side; settings: RoomSettings }
  | { op: 'join'; protocol: number; build: string; code: string }
  | { op: 'rejoin'; protocol: number; build: string; code: string; token: string }
  | { op: 'settings'; settings: RoomSettings }
  | { op: 'roster'; forces: string[]; ready: boolean }
  | { op: 'wire'; generation: number; envelope: Envelope }
  | { op: 'progress'; generation: number; turn: number }
  | { op: 'frozen'; generation: number; turn: number; sealedTo:number }
  | { op:'rebuilding'; generation:number; turn:number }
  | { op:'rebuildFailed'; generation:number }
  | { op: 'rebuilt'; generation: number; turn: number; hash: number }
  | { op: 'leave'; mode: 'ai' | 'forfeit' | 'quit' };
export type ServerFrame =
  | { op: 'member'; side: Side; token: string; room: RoomView }
  | { op: 'room'; room: RoomView }
  | { op: 'start'; config: BattleConfig; generation: number }
  | { op: 'wire'; generation: number; envelope: Envelope }
  | { op: 'freeze'; generation: number }
  | { op: 'history'; config: BattleConfig; generation: number; history: TurnHistory }
  | { op: 'play'; generation: number }
  | { op: 'closed'; reason: string; forfeit?: Side }
  | { op: 'error'; code: string; message: string };

export function isRecord(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
export function isSide(v: unknown): v is Side { return v === 'german' || v === 'soviet'; }
export function validTurn(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 1_000_000;
}
export function validSettings(v: unknown): v is RoomSettings {
  return isRecord(v) && typeof v.mapId === 'string' && v.mapId.length <= 80
    && Number.isInteger(v.year) && v.year >= 1941 && v.year <= 1945
    && Number.isInteger(v.durationS) && v.durationS >= 60 && v.durationS <= 3600
    && Number.isInteger(v.seed) && v.seed >= 0 && v.seed <= 0xffffffff
    && Number.isInteger(v.points) && v.points >= 50 && v.points <= 1000;
}
