// Emscripten Module properties that looked interesting enough to write documentation for
export interface EmscriptenModuleKnownOptions {
  // default: 16MiB, which you can express as 16 * 1024**2
  // initial heap size.
  // must be a multiple of 65536 (it's 16KiB pages, 16 * 1024 bytes each)
  INITIAL_MEMORY: number;
}

// Combine known options with arbitrary properties
export type ModuleOptions = Partial<EmscriptenModuleKnownOptions> & Record<string, any>;

export default function MainModuleFactory(
  options?: ModuleOptions
): Promise<MainModule>;