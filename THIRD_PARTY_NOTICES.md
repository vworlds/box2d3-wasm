# Third-party notices

This package contains or is built from the following third-party works. The package's own licence
is in [LICENSE](LICENSE).

## Box2D

The WebAssembly modules in `dist/` are compiled from [Box2D](https://github.com/erincatto/box2d)
v3 (the `box2d` submodule of the source repository), with one small patch (see `patches/`).

```
MIT License

Copyright (c) 2022 Erin Catto

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## box2d3-wasm

This package began as a fork of [Birch-san/box2d3-wasm](https://github.com/Birch-san/box2d3-wasm)
by Alex Birch and Erik Sombroek, which is MIT licensed; its copyright notice is kept in
[LICENSE](LICENSE).

## wasm-feature-detect

`dist/entry.mjs` contains the SIMD validation expression (a small WebAssembly module as a byte
array) from [wasm-feature-detect](https://github.com/GoogleChromeLabs/wasm-feature-detect), which
is licensed under the Apache License, Version 2.0. The notice that accompanies it in the source:

```
Copyright 2019 Google Inc. All Rights Reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
    http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## Emscripten output

The `.mjs` and `.wasm` files in `dist/` are produced by [Emscripten](https://emscripten.org/) and
include parts of its runtime, its C and C++ standard libraries and embind. Those parts are
distributed under the licences of the Emscripten project and the libraries it ships (see
https://github.com/emscripten-core/emscripten/blob/main/LICENSE).
