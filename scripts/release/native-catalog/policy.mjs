// Reviewed MS003/MS004 qualification tuple; changing it requires new native evidence.
export const NATIVE_CATALOG_TUPLE = Object.freeze({
  profile: "desktop-apple-virtualization-native-arm64",
  controller: { os: "darwin", architecture: "arm64", node: "24.18.0", macos: "26.5.1" },
  daemon: { desktop: "4.54.0", build: 212467, engine: "29.1.2", api: "1.52", kernel: "6.12.54-linuxkit", architecture: "arm64" },
  workloadImage: "sha256:d37b995fa50e42c916e155122879403df1660ec72c94c4cc27c1f18e2c3b6d23",
  native: { executable: "/usr/local/bin/grok", version: "1.0.70", bytes: 166639048,
    sha256: "3aa36883574b263088e5addffe241f55430e8daaee1a0c4934b02180007a9761" },
  bootstrap: { executable: "/usr/local/bin/agenai-credential-bootstrap", bytes: 880544,
    sha256: "a6bfacfc40a62c0eb18155f5669c24195e9bb285781bb7f90603ae596753aed1" },
  helper: { image: "sha256:1065017c9cd33efd9e6dd7cb55f4970984fba7ff32eedc26f064e93b85d7749f",
    baseImage: "docker.io/library/node@sha256:4ff2a3b4ac84d69e1f1a7f49d683e9675babea1828bdeeec1af0c6b7690ed0a4",
    protocol: "agenai.sandbox.egress-connect.v1", user: { uid: 65534, gid: 65534 },
    sourceDigest: "sha256:734b16f0b2932a432e54c43d69f16fcabb210eaa533df44eedf601886ad24cc5" },
});

export const HELPER_FILES = Object.freeze(["helpers/broker.js", "helpers/connection.js", "helpers/control.js", "helpers/entry.js",
  "helpers/protocol.js", "helpers/relay.js", "helpers/socketDirectory.js", "network/address.js", "network/policy.js"]);
