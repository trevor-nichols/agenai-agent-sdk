// ------------------------------------------------------------------------------------------------
//                profiles.ts - Closed controller, daemon and guest platform compositions
// ------------------------------------------------------------------------------------------------

export const DOCKER_SANDBOX_PROFILES = ['linux-x64', 'desktop-apple-virtualization-native-arm64', 'desktop-apple-virtualization-rosetta-amd64'] as const;

export type DockerSandboxProfile = typeof DOCKER_SANDBOX_PROFILES[number];

const profiles = {
  'linux-x64': {
    controllerOS: 'linux', controllerArchitecture: 'x64', daemonArchitecture: 'amd64',
    daemonInfoArchitectures: ['amd64', 'x86_64'], workloadImageArchitecture: 'amd64', helperImageArchitecture: 'amd64',
    cgroupDriver: 'systemd', appArmorProfile: 'docker-default', desktop: false,
  },
  'desktop-apple-virtualization-native-arm64': {
    controllerOS: 'darwin', controllerArchitecture: 'arm64', daemonArchitecture: 'arm64',
    daemonInfoArchitectures: ['arm64', 'aarch64'], workloadImageArchitecture: 'arm64', helperImageArchitecture: 'arm64',
    cgroupDriver: 'cgroupfs', appArmorProfile: '', desktop: true,
  },
  'desktop-apple-virtualization-rosetta-amd64': {
    controllerOS: 'darwin', controllerArchitecture: 'arm64', daemonArchitecture: 'arm64',
    daemonInfoArchitectures: ['arm64', 'aarch64'], workloadImageArchitecture: 'amd64', helperImageArchitecture: 'arm64',
    cgroupDriver: 'cgroupfs', appArmorProfile: '', desktop: true,
  },
} satisfies Record<DockerSandboxProfile, {
  readonly controllerOS: string; readonly controllerArchitecture: string;
  readonly daemonArchitecture: string; readonly daemonInfoArchitectures: readonly string[];
  readonly workloadImageArchitecture: 'amd64' | 'arm64'; readonly helperImageArchitecture: 'amd64' | 'arm64'; readonly cgroupDriver: string;
  readonly appArmorProfile: string; readonly desktop: boolean;
}>;

export function dockerProfile(profile: DockerSandboxProfile) {
  return profiles[profile];
}

export function dockerBackendRevision(profile: DockerSandboxProfile): string {
  return `engine-1.52-v${dockerProfile(profile).desktop ? 6 : 5}-${profile}`;
}
