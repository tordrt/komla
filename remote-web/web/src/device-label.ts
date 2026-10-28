export function deriveDefaultDeviceLabel(userAgent: string): string {
  const browser = userAgent.includes('Edg/')
    ? 'Edge'
    : userAgent.includes('Firefox/')
      ? 'Firefox'
      : userAgent.includes('Chrome/')
        ? 'Chrome'
        : userAgent.includes('Safari/')
          ? 'Safari'
          : 'Browser';
  const os = userAgent.includes('iPhone') || userAgent.includes('iPad')
    ? 'iOS'
    : userAgent.includes('Mac OS X')
      ? 'macOS'
      : userAgent.includes('Windows')
        ? 'Windows'
        : userAgent.includes('Android')
          ? 'Android'
          : userAgent.includes('Linux')
            ? 'Linux'
            : 'this device';
  return `${browser} on ${os}`;
}
