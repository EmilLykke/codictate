// swift-tools-version: 6.2
// 6.2 is the floor for `traits: []` below: FluidAudio only exposes its NeMo engine as an
// opt-out trait in its tools-6.2 manifest, and older toolchains link it unconditionally.

import PackageDescription

let package = Package(
  name: "CodictateParakeetHelper",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "CodictateParakeetHelper", targets: ["CodictateParakeetHelper"]),
  ],
  dependencies: [
    // Pinned exactly: a FluidAudio bump can move the model file names and folder layout the
    // helper and `src/bun/utils/whisper/model-manager.ts` agree on, so it is a reviewed change.
    //
    // `traits: []` drops FluidAudio's bundled NeMo text normalization (text-processing-rs
    // v0.3.1 as an xcframework). The helper links its own build through CNemoTextProcessing
    // (`scripts/pre-build.ts`). Both export the same `nemo_*` symbols under the same Clang
    // module name, and with the trait on the build still succeeds: the linker silently binds
    // the helper's calls to FluidAudio's copy, so ITN would follow FluidAudio's engine
    // version instead of the one pre-build pins, and the binary grows by ~7 MB.
    .package(
      url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.17.7", traits: []),
  ],
  targets: [
    .systemLibrary(
      name: "CNemoTextProcessing",
      path: "Sources/CNemoTextProcessing"
    ),
    .executableTarget(
      name: "CodictateParakeetHelper",
      dependencies: [
        .product(name: "FluidAudio", package: "FluidAudio"),
        "CNemoTextProcessing",
      ],
      linkerSettings: [
        // CNemoTextProcessing modulemap links `text_processing_rs`; only the search path is extra.
        .unsafeFlags(["-LVendor/lib"]),
        .linkedFramework("AVFoundation"),
        .linkedFramework("CoreAudio"),
        .linkedFramework("AppKit"),
        .linkedFramework("ApplicationServices"),
      ]
    ),
  ]
)
