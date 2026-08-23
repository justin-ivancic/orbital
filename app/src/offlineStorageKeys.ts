export const getOfflineResourceStorageKey = (downloadId: string, resourceKey: string) =>
  `${downloadId}\u0000${resourceKey}`
