#ifndef AGENAI_DESKTOP_RECOVERY_PROFILE_H
#define AGENAI_DESKTOP_RECOVERY_PROFILE_H

#define RECOVERY_APPLICATION "/Applications/Docker.app"
#define RECOVERY_PROFILE "stock-desktop-4.54.0-engine-29.1.2-native-arm64-v1"
#define RECOVERY_TEAM "9BNSXJN65R"
#define RECOVERY_COMPONENTS_SHA "a8a6744cf7e64ac4d5850bc9f3ce3cf3ad5aaf43d97e3e07fbebc7a56d47230b"

#define RECOVERY_IMAGE_ROWS \
    { "Contents/MacOS/com.docker.backend", "backend", "5cf0f8e7b7397c48862998d9e0c580d3787f0fb76b0a321802621caf118bc2d3", "com.docker.docker" }, \
    { "Contents/MacOS/com.docker.virtualization", "virtualization", "c0bbcd6a060f6383872852ab9481559c8426daee4d502bc1abc51755a6feea50", "com.docker" }, \
    { "Contents/MacOS/com.docker.build", "build", "9b6f9fb0ee6ab1f3fb248ed99b235b4e10fd8ae16418590523a714471fe3e20d", "com.docker" }, \
    { "Contents/Resources/bin/docker", "docker_cli", "89ef31fa272062631ab5fd00a42f860c949d8ffc17e70364198e89707581f492", "docker" }, \
    { "Contents/Resources/cli-plugins/docker-desktop", "desktop_cli", "bc00362417d9d18bf62041904fa908db26b53f7b5a68aea7f95df612da138ca6", "docker-desktop" }, \
    { "Contents/MacOS/Docker Desktop.app/Contents/MacOS/Docker Desktop", "desktop_ui", "29163c2e5b747ca608a6f1f75a5d008c7ac8d47f3b313416cb48ccbedd75390f", "com.electron.dockerdesktop" }, \
    { "Contents/MacOS/Docker Desktop.app/Contents/Frameworks/Docker Desktop Helper (GPU).app/Contents/MacOS/Docker Desktop Helper (GPU)", "desktop_gpu", "c4d2da5b301392abe9d1e378e409c5f06de18748b8ca9a71e4d6e01cd5fff86d", "com.electron.dockerdesktop.helper.GPU" }, \
    { "Contents/MacOS/Docker Desktop.app/Contents/Frameworks/Docker Desktop Helper.app/Contents/MacOS/Docker Desktop Helper", "desktop_helper", "9592b2ee78cd8e0ad21e8ae570f726f1193adcda0d5d40c4d2608b3396540595", "com.electron.dockerdesktop.helper" }, \
    { "Contents/MacOS/Docker Desktop.app/Contents/Frameworks/Docker Desktop Helper (Renderer).app/Contents/MacOS/Docker Desktop Helper (Renderer)", "desktop_renderer", "a8acf4dc82fa51d4f7e2a5d6fdead9053cf47b4e3e087626e60a14dda168b8c0", "com.electron.dockerdesktop.helper.Renderer" }, \
    { "Contents/Resources/cli-plugins/docker-ai", "plugin_ai", "be0cc415b21cd35036bb984020f37ed82fe86995fe7fe6f66eeb387b6cee92ae", "docker-ai" }, \
    { "Contents/Resources/cli-plugins/docker-buildx", "plugin_buildx", "4d3cdf95873e8e5c78311ba33085110d1e7ab97d47598bdd20207b345333f41a", "docker-buildx" }, \
    { "Contents/Resources/cli-plugins/docker-compose", "plugin_compose", "3458a5379711a8b32e15da292c1bc9a68021b9af1d52beae04d7e3d043b1138c", "docker-compose" }, \
    { "Contents/Resources/cli-plugins/docker-debug", "plugin_debug", "e06e8837012517bde84779af523224a5ca364fc651774b01c08faf32033975f0", "docker-debug" }, \
    { "Contents/Resources/cli-plugins/docker-extension", "plugin_extension", "7c64019007621bbe50c2db3083096ae6bc374d5ffb55811a82c179e5444705e3", "docker-extension" }, \
    { "Contents/Resources/cli-plugins/docker-init", "plugin_init", "cb084941913b70406892c7f4ab72eeeb56a39cf86fe0f6f6e2f0d78b12a251d2", "docker-init" }, \
    { "Contents/Resources/cli-plugins/docker-mcp", "plugin_mcp", "a99507bf65f5b99a9840055d395f3aadd4a0663486e3bfce5188376607fc8e3e", "docker-mcp" }, \
    { "Contents/Resources/cli-plugins/docker-model", "plugin_model", "894915e7aa5bac6306224b0d02585756f3e21d1855194c0bd2084f6de48b214e", "docker-model" }, \
    { "Contents/Resources/cli-plugins/docker-offload", "plugin_offload", "c312a928477d23ae96dcef3b66fd3123f26c3a6edfb8040d6eb1ab426acd69de", "docker-offload" }, \
    { "Contents/Resources/cli-plugins/docker-sandbox", "plugin_sandbox", "57d5eb3ed06d66133f456be26e9c2c0ff97a3caf22989f0e051d236fe14cd94d", "docker-sandbox" }, \
    { "Contents/Resources/cli-plugins/docker-sbom", "plugin_sbom", "52d29ee8abe56d685033c2d78264fc798942192b60b2ee5236a64c83122ecf8e", "docker-sbom" }, \
    { "Contents/Resources/cli-plugins/docker-scout", "plugin_scout", "83481966e3da11f595f1d56f492a9782f6e41f5d76096af0247b824dea64cdc8", "docker-scout" }, \
    { "Contents/Library/SecretsEngine/docker-pass.app/Contents/MacOS/docker-pass", "secrets_pass", "13b74bf06ce54b99b13966fef76ff085c25e8c1f61c4cc4d77cef12d287fa522", "docker-pass" }, \
    { "Contents/Resources/bin/docker-credential-desktop", "credential_desktop", "9c7035035dc8290afd89f9d0e08f7d5e583f7e26b96323536e2c785b4e1ce96d", "docker-credential-desktop" }, \
    { "Contents/Resources/bin/docker-credential-osxkeychain", "credential_osxkeychain", "23fd4e2c8f2f2e5ff585aad4065f1c68150abd70fac006e09ad27c946ce66c59", "docker-credential-osxkeychain" }, \
    { "Contents/Resources/bin/docker-credential-ecr-login", "credential_ecr_login", "e57fed732e6c052ab5e58da9c05f0f6333deff9d8c5f942d7627dc1806d2631f", "docker-credential-ecr-login" }, \
    { "Contents/Resources/bin/kubectl", "kubectl", "b85637d6d01b26ac5b62904ecc9bfd9d7b53c2cdfb6a25dc745bc510c5dfdbd0", "kubectl" },

#endif
