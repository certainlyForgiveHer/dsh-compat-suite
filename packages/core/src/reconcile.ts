/**
 * manifest / lockfile / node_modules three-way reconciliation (C1).
 *
 * C1 reports *identity* defects only: whether the declared, locked and installed
 * versions agree, whether the package is present at all, and whether a name
 * resolves to more than one version. Compatibility judgement belongs to C2.
 *
 * Codes emitted here come from the docs/07 section 4 registry:
 *   version-skew-manifest-lock, version-skew-lock-actual,
 *   package-missing, ambiguous-resolution, scan-infrastructure-error
 */

import { discoverLoaderState, parseNodeModules, parseProfileManifest, parsePnpmLock } from './parsers.js';
import { pinnedVersionFromSpecifier, isExactVersion } from './version.js';
import { defaultProfileLayout } from './inventory-types.js';
import type { ParseError, PluginReconcile, ProfileLayout, ReconcileResult } from './inventory-types.js';

function compareVersions(left: string, right: string): boolean {
  return left === right;
}

/**
 * Reconcile one profile.
 *
 * The manifest/lock comparison is only decidable when the specifier pins a
 * single version. For a genuine range (`^1.0.0`, `workspace:*`) a lockfile that
 * resolves inside the range is *not* a skew, and inverting the range is
 * impossible — so no finding is raised and the identity is reported as-is with
 * `lockVersion` carrying the resolved value.
 */
export function reconcilePlugins(
  profilePath: string,
  layout: ProfileLayout = defaultProfileLayout(),
): ReconcileResult {
  const manifest = parseProfileManifest(profilePath, layout);
  const lock = parsePnpmLock(profilePath, layout);
  const { actual, errors } = parseNodeModules(profilePath, layout);

  const infrastructureError: ParseError | null =
    manifest.error ?? lock.error ?? (errors.length > 0 ? errors[0] : null);

  const actualVersions = new Map<string, readonly string[]>();
  for (const [name, entry] of actual) actualVersions.set(name, entry.versions);

  if (infrastructureError !== null) {
    return { error: infrastructureError, byName: new Map(), pluginOrder: [], actualVersions };
  }

  const names = new Set<string>([...Object.keys(manifest.dependencies), ...lock.specifiers.keys()]);
  const pluginOrder = [...names].sort();

  // Loader discovery reads the profile's own cordis patch layer. A layer that
  // cannot be read is an infrastructure error like a corrupted lockfile: the
  // disabled state decides whether a missing package is a scan error or a
  // degradation, so guessing it would silently change the conclusion.
  const loaders = discoverLoaderState(profilePath, layout, actual, pluginOrder);
  if (loaders.error !== null) {
    return { error: loaders.error, byName: new Map(), pluginOrder: [], actualVersions };
  }

  const byName = new Map<string, PluginReconcile>();
  for (const name of pluginOrder) {
    const manifestSpecifier = manifest.dependencies[name] ?? null;
    const lockEntry = lock.packages.get(name);
    const lockVersion = lockEntry?.version ?? null;
    const actualEntry = actual.get(name);
    const versions = actualEntry?.versions ?? [];
    const ambiguous = versions.length > 1;
    const actualVersion = versions.length === 0 ? null : versions[0];

    const loaderState = loaders.byName.get(name) ?? { loaderIds: [], enabled: null };

    let reconcileCode: string | null = null;
    if (ambiguous) {
      reconcileCode = 'ambiguous-resolution';
    } else if (actualVersion === null) {
      // Declared or locked but absent from node_modules. docs/01 section 7.3
      // keys the outcome on whether the plugin is still enabled: the loader
      // layers decide that, and the manifest declaration is only the fallback
      // when no loader row names the plugin at all.
      reconcileCode = 'package-missing';
    } else {
      const pinned = pinnedVersionFromSpecifier(manifestSpecifier);
      // A lock value that is not a concrete version (a git URL, tarball, file
      // or link reference) cannot be compared with an installed version, so no
      // skew is claimed. Fabricating one would be a false positive on the very
      // dependencies pnpm keys by reference.
      const lockIsVersion = lockVersion !== null && isExactVersion(lockVersion);
      if (pinned !== null && lockIsVersion && !compareVersions(pinned, lockVersion)) {
        reconcileCode = 'version-skew-manifest-lock';
      } else if (lockIsVersion && !compareVersions(lockVersion, actualVersion)) {
        reconcileCode = 'version-skew-lock-actual';
      }
    }

    byName.set(name, {
      name,
      manifestSpecifier,
      lockVersion,
      actualVersion,
      integrity: lockEntry?.integrity ?? null,
      enabled: loaderState.enabled ?? manifestSpecifier !== null,
      loaderIds: loaderState.loaderIds,
      ambiguous,
      reconcileCode,
    });
  }

  return { error: null, byName, pluginOrder, actualVersions };
}
