// Types for box2d3-wasm/fastpath: the b2x_ fast path (plain wasm exports, no embind).
// Reference: docs/fastpath.md in the vworlds/box2d3-wasm repository.
import type { MainModule } from "./deluxe/Box2D.deluxe";
import type { FastPathBodyExports } from "./fastpath_body.gen";

export type { FastPathBodyExports } from "./fastpath_body.gen";

/** The module with the generated b2x_Body_* declarations typed by parameter name. */
export type FastPathModule = MainModule & FastPathBodyExports;

/** A struct layout: `size` and field offsets, all in bytes, generated in C with sizeof/offsetof. */
export type StructLayout<F extends string> = { size: number } & Record<F, number>;

export interface FastPathLayout {
  constants: {
    version: number;
    /** Export flag: fill vx/vy/w from b2Body_GetLinearVelocity / b2Body_GetAngularVelocity. */
    exportVelocity: number;
    /** Export flag: skip bodies that are not dynamic. */
    exportDynamicOnly: number;
    /** b2xMove.flags bit: the move event's fellAsleep. */
    moveFellAsleep: number;
    /** b2xMove.flags: (flags >> moveTypeShift) & 3 is the b2BodyType (0 static, 1 kinematic, 2 dynamic). */
    moveTypeShift: number;
    /** b2xMove.flags bit: the body id was valid at export (velocities are only read then). */
    moveValid: number;
  };
  /** b2x_World_ExportMoves record. All fields 4-byte aligned. */
  move: StructLayout<
    "bodyIndex" | "rev" | "userData" | "flags" | "x" | "y" | "c" | "s" | "angle" | "vx" | "vy" | "w"
  >;
  /** b2x_Body_GetPose output. */
  pose: StructLayout<"x" | "y" | "c" | "s" | "angle">;
  /** b2x_Body_GetMotion output (`awake` is an int32 1/0). */
  motion: StructLayout<
    | "awake"
    | "vx"
    | "vy"
    | "w"
    | "linearDamping"
    | "angularDamping"
    | "localCenterX"
    | "localCenterY"
    | "mass"
    | "gravityScale"
  >;
  span: StructLayout<"ptr" | "count">;
  contactSpans: StructLayout<"beginPtr" | "beginCount" | "endPtr" | "endCount" | "hitPtr" | "hitCount">;
  sensorSpans: StructLayout<"beginPtr" | "beginCount" | "endPtr" | "endCount">;
  /** Box2D's b2BodyMoveEvent. `bodyWorld0`/`bodyGeneration` are uint16, `fellAsleep` a byte. */
  moveEvent: StructLayout<
    "userData" | "x" | "y" | "c" | "s" | "body" | "bodyWorld0" | "bodyGeneration" | "fellAsleep"
  >;
  contactBegin: StructLayout<ShapePairFields | "contact">;
  contactEnd: StructLayout<ShapePairFields | "contact">;
  contactHit: StructLayout<
    ShapePairFields | "pointX" | "pointY" | "normalX" | "normalY" | "approachSpeed"
  >;
  sensorBegin: StructLayout<SensorPairFields>;
  sensorEnd: StructLayout<SensorPairFields>;
}

type ShapePairFields =
  | "shapeA"
  | "shapeAWorld0"
  | "shapeAGeneration"
  | "shapeB"
  | "shapeBWorld0"
  | "shapeBGeneration";
type SensorPairFields =
  | "sensorShape"
  | "sensorShapeWorld0"
  | "sensorShapeGeneration"
  | "visitorShape"
  | "visitorShapeWorld0"
  | "visitorShapeGeneration";

export interface FastPath {
  readonly module: FastPathModule;
  readonly memory: WebAssembly.Memory;
  readonly layout: FastPathLayout;
  /**
   * Whole-memory views. Memory can grow during any call that allocates in wasm (creating
   * worlds/bodies/shapes/joints, stepping, embind calls returning by value, malloc). Call
   * {@link sync} after such a call and before reading; re-read these properties after a sync.
   */
  readonly buffer: ArrayBufferLike;
  readonly u8: Uint8Array;
  readonly u16: Uint16Array;
  readonly i32: Int32Array;
  readonly u32: Uint32Array;
  readonly f32: Float32Array;
  /** Rebuild the views if memory grew since the last sync. Returns true when it rebuilt them. */
  sync(): boolean;
  /** Packed world id: index1 | generation << 16. */
  world(worldId: { index1: number; generation: number }): number;
  /** `rev` half of a packed body/shape/chain/joint id: world0 | generation << 16. */
  rev(id: { world0: number; generation: number }): number;
  /** malloc + sync. Throws on failure. */
  alloc(bytes: number): number;
  free(ptr: number): void;
  createMoveExporter(initialCapacity?: number): MoveExporter;
  /**
   * Turn Box2D's profile timers on or off (b2World_GetProfile reads 0 while off). They never
   * affect simulation results; off removes a JS clock call per timed section of every step.
   */
  setProfileTimers(enabled: boolean): void;
}

export interface MoveExporter {
  /** Byte address of record 0. */
  readonly ptr: number;
  /** Word index of record 0 in the i32/u32/f32 views. */
  readonly base: number;
  /** Words per record. */
  readonly stride: number;
  readonly capacity: number;
  /** Records written by the last export. */
  readonly count: number;
  /**
   * Export the world's move events (one record each, Box2D's event order) and sync the views.
   * `flags`: layout.constants.exportVelocity | exportDynamicOnly.
   */
  exportMoves(world: number, flags: number): number;
  /** Step the world, then export, in one crossing. */
  stepAndExportMoves(world: number, timeStep: number, subStepCount: number, flags: number): number;
  dispose(): void;
}

export function createFastPath(module: MainModule): FastPath;
