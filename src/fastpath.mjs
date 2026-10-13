// box2d3-wasm/fastpath: helpers for the b2x_ fast path (see fastpath.d.ts and docs/fastpath.md).
//
// The fast path is a set of plain wasm exports on the module (module._b2x_*). This helper parses
// their struct layout (generated in C from sizeof/offsetof), keeps whole-memory typed views that
// survive memory growth, packs embind ids into integers and manages export buffers. None of its
// per-step methods allocate.

export function createFastPath(module) {
  const memory = module.wasmMemory;
  if (!memory || typeof module._b2x_GetLayout !== "function") {
    throw new Error("box2d3-wasm build without the b2x_ fast path");
  }
  const fp = {
    module,
    memory,
    layout: undefined,
    buffer: undefined,
    u8: undefined,
    u16: undefined,
    i32: undefined,
    u32: undefined,
    f32: undefined,
    sync() {
      const buffer = memory.buffer;
      if (buffer === fp.buffer) {
        return false;
      }
      fp.buffer = buffer;
      fp.u8 = new Uint8Array(buffer);
      fp.u16 = new Uint16Array(buffer);
      fp.i32 = new Int32Array(buffer);
      fp.u32 = new Uint32Array(buffer);
      fp.f32 = new Float32Array(buffer);
      return true;
    },
    world(worldId) {
      return worldId.index1 | (worldId.generation << 16);
    },
    rev(id) {
      return id.world0 | (id.generation << 16);
    },
    alloc(bytes) {
      const ptr = module._malloc(bytes);
      if (ptr === 0) {
        throw new Error(`b2x: out of memory allocating ${bytes} bytes`);
      }
      fp.sync();
      return ptr;
    },
    free(ptr) {
      module._free(ptr);
    },
    createMoveExporter(initialCapacity = 64) {
      return new MoveExporter(fp, initialCapacity);
    },
    setProfileTimers(enabled) {
      if (typeof module._b2x_SetProfileTimers === "function") {
        module._b2x_SetProfileTimers(enabled ? 1 : 0);
      }
    },
  };
  fp.sync();
  fp.layout = readLayout(fp, module._b2x_GetLayout());
  if (fp.layout.constants.version !== module._b2x_GetVersion()) {
    throw new Error("b2x layout version mismatch");
  }
  return fp;
}

function readLayout(fp, ptr) {
  const u8 = fp.u8;
  let end = ptr;
  while (u8[end] !== 0) {
    end++;
  }
  // slice() copies into a non-shared buffer, which TextDecoder accepts.
  return JSON.parse(new TextDecoder().decode(u8.slice(ptr, end)));
}

/** Owns a growable wasm buffer of b2xMove records and fills it with one crossing per call. */
class MoveExporter {
  constructor(fp, initialCapacity) {
    this.fp = fp;
    this.capacity = Math.max(1, initialCapacity | 0);
    this.ptr = fp.alloc(this.capacity * fp.layout.move.size);
    /** Word index of record 0 in fp.i32 / fp.u32 / fp.f32. */
    this.base = this.ptr >> 2;
    /** Words per record. */
    this.stride = fp.layout.move.size >> 2;
    this.count = 0;
  }

  /** Export the moves of `world` (packed id). Returns the record count; views are synced. */
  exportMoves(world, flags) {
    const fp = this.fp;
    let count = fp.module._b2x_World_ExportMoves(world, this.ptr, this.capacity, flags);
    if (count > this.capacity) {
      this.grow(count);
      count = fp.module._b2x_World_ExportMoves(world, this.ptr, this.capacity, flags);
    }
    fp.sync();
    this.count = count;
    return count;
  }

  /** Step `world`, then export its moves, in one crossing. */
  stepAndExportMoves(world, timeStep, subStepCount, flags) {
    const fp = this.fp;
    let count = fp.module._b2x_World_StepAndExportMoves(
      world,
      timeStep,
      subStepCount,
      this.ptr,
      this.capacity,
      flags
    );
    if (count > this.capacity) {
      this.grow(count);
      count = fp.module._b2x_World_ExportMoves(world, this.ptr, this.capacity, flags);
    }
    fp.sync();
    this.count = count;
    return count;
  }

  grow(minCapacity) {
    const fp = this.fp;
    let capacity = this.capacity;
    while (capacity < minCapacity) {
      capacity *= 2;
    }
    fp.free(this.ptr);
    this.capacity = capacity;
    this.ptr = fp.alloc(capacity * fp.layout.move.size);
    this.base = this.ptr >> 2;
  }

  dispose() {
    this.fp.free(this.ptr);
    this.ptr = 0;
    this.capacity = 0;
  }
}
