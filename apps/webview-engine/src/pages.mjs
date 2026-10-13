export async function launcherCandidates(pages, launcherUrlPrefix, startUrl) {
  let candidates = launcherUrlPrefix
    ? pages.filter((p) => p.url().startsWith(launcherUrlPrefix))
    : pages.filter((p) => !/^(about:|data:)/.test(p.url()));
  if (!launcherUrlPrefix && candidates.length > 1) {
    const exact = candidates.filter((p) => p.url() === startUrl);
    const local = candidates.filter((p) => p.url().startsWith('file:'));
    if (exact.length) candidates = exact;
    else if (local.length === 1) candidates = local;
  }
  if (candidates.length > 1) {
    const visible = [];
    for (const page of candidates) {
      const state = await page
        .evaluate(() => document.visibilityState)
        .catch(() => null);
      if (state === 'visible') visible.push(page);
    }
    if (visible.length === 1) candidates = visible;
  }
  return candidates;
}
