// Types for box2d3-wasm/fastpath: the b2x_ fast path (plain wasm exports, no embind).
// Reference: docs/fastpath.md in the vworlds/box2d3-wasm repository.
import type { MainModule } from "./deluxe/Box2D.deluxe";
import type { FastPathBodyExports } from "./fastpath_body.gen";

export type { FastPathBodyExports } from "./fastpath_body.gen";

/**
 * The hand-written b2x_ exports (src/fastpath.cpp), typed by parameter name. All arguments and
 * results are plain numbers: ids are packed (see {@link FastPath.world} and {@link FastPath.rev}),
 * pointers are byte addresses in wasm memory, floats cross as f32.
 */
export interface FastPathCoreExports {
  /** JSON layout of every exposed struct (sizes and byte offsets from sizeof/offsetof); a C
   * string at the returned address. Read it through {@link FastPath.layout}. */
  _b2x_GetLayout(): number;
  /** Fast-path API version (layout.constants.version). */
  _b2x_GetVersion(): number;
  /** Box2D's profile timers on (1, default) or off (0). Off: b2World_GetProfile reads zeros,
   * results are unaffected, each step makes no JavaScript clock calls. Global to the module. */
  _b2x_SetProfileTimers(enabled: number): void;
  _b2x_GetProfileTimers(): number;
  /** b2World_Step(world, timeStep, subStepCount). May grow memory. */
  _b2x_World_Step(world: number, timeStep: number, subStepCount: number): void;
  /** Move-event count of the last step. */
  _b2x_World_GetMoveCount(world: number): number;
  /**
   * Write one b2xMove record (layout.move) per move event of the last step, in Box2D's event
   * order, to `outPtr` (at most `capacity`). Returns the number of records the export produced;
   * if it exceeds `capacity` only `capacity` were written: grow and call again (the events stay
   * valid until the next step). `flags`: layout.constants.exportVelocity | exportDynamicOnly.
   * Never grows memory.
   */
  _b2x_World_ExportMoves(world: number, outPtr: number, capacity: number, flags: number): number;
  /** b2x_World_Step then b2x_World_ExportMoves in one crossing. */
  _b2x_World_StepAndExportMoves(
    world: number,
    timeStep: number,
    subStepCount: number,
    outPtr: number,
    capacity: number,
    flags: number
  ): number;
  /** Write {ptr, count} (layout.span) of Box2D's own b2BodyMoveEvent array (layout.moveEvent). */
  _b2x_World_GetMoveEventSpan(world: number, outPtr: number): void;
  /** Write the begin/end/hit spans (layout.contactSpans) of Box2D's contact event arrays
   * (layouts contactBegin, contactEnd, contactHit). Valid until the next step or world change. */
  _b2x_World_GetContactSpans(world: number, outPtr: number): void;
  /** Write the begin/end spans (layout.sensorSpans) of Box2D's sensor event arrays
   * (layouts sensorBegin, sensorEnd). Valid until the next step or world change. */
  _b2x_World_GetSensorSpans(world: number, outPtr: number): void;
  /** Store an unsigned 32-bit integer in the body's user data; move records carry it. */
  _b2x_Body_SetUserData(index1: number, rev: number, value: number): void;
  _b2x_Body_GetUserData(index1: number, rev: number): number;
  _b2x_Shape_SetUserData(index1: number, rev: number, value: number): void;
  _b2x_Shape_GetUserData(index1: number, rev: number): number;
  /** b2Body_SetTransform(id, {x, y}, b2Body_GetRotation(id)). */
  _b2x_Body_SetPosition(index1: number, rev: number, x: number, y: number): void;
  /** b2Body_SetTransform(id, b2Body_GetPosition(id), b2MakeRot(angle)). */
  _b2x_Body_SetAngle(index1: number, rev: number, angle: number): void;
  /** Write position, rotation and b2Rot_GetAngle (layout.pose) to `outPtr`. */
  _b2x_Body_GetPose(index1: number, rev: number, outPtr: number): void;
  /** Write awake, velocities, damping, local center, mass, gravity scale (layout.motion). */
  _b2x_Body_GetMotion(index1: number, rev: number, outPtr: number): void;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  wasmMemory: WebAssembly.Memory;
}

/** The module with every b2x_ export typed by parameter name, on top of the embind API. */
export type FastPathModule = MainModule & FastPathCoreExports & FastPathBodyExports;

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
