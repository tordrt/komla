import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { hostname } from 'os';

/**
 * Get a stable, privacy-preserving machine identifier.
 *
 * Platform-specific approaches:
 * - macOS: Hash of IOPlatformSerialNumber (survives OS reinstall)
 * - Windows: Hash of registry MachineGuid (stable across reinstalls)
 * - Linux: Hash of /etc/machine-id (systemd-generated, stable)
 *
 * All values are hashed with SHA-256 so raw hardware IDs never leave the device.
 */
export function getMachineId(): string {
  try {
    let rawId: string;

    switch (process.platform) {
      case 'darwin':
        rawId = getMacOSMachineId();
        break;
      case 'win32':
        rawId = getWindowsMachineId();
        break;
      case 'linux':
        rawId = getLinuxMachineId();
        break;
      default:
        // Fallback for unsupported platforms
        rawId = getFallbackMachineId();
    }

    // Hash the raw ID for privacy
    return createHash('sha256').update(rawId).digest('hex');
  } catch (error) {
    // If all else fails, generate a fallback based on hostname
    // This is less stable but better than nothing
    console.error('Failed to get machine ID:', error);
    return createHash('sha256').update(getFallbackMachineId()).digest('hex');
  }
}

/**
 * Get a human-readable machine name for display in the UI.
 */
export function getMachineName(): string {
  return hostname();
}

function getMacOSMachineId(): string {
  // Get IOPlatformSerialNumber via ioreg
  const output = execSync('ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformSerialNumber', {
    encoding: 'utf-8',
    timeout: 5000,
  });

  // Parse the output: "IOPlatformSerialNumber" = "XXXXXXXXXXXX"
  const match = output.match(/"IOPlatformSerialNumber"\s*=\s*"([^"]+)"/);
  if (!match) {
    throw new Error('Could not parse IOPlatformSerialNumber');
  }

  return `darwin:${match[1]}`;
}

function getWindowsMachineId(): string {
  // Get MachineGuid from registry
  const output = execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', {
    encoding: 'utf-8',
    timeout: 5000,
  });

  // Parse the output
  const match = output.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
  if (!match) {
    throw new Error('Could not parse MachineGuid');
  }

  return `win32:${match[1]}`;
}

function getLinuxMachineId(): string {
  // Read /etc/machine-id (systemd standard, present on most modern distros)
  const machineIdPath = '/etc/machine-id';
  if (existsSync(machineIdPath)) {
    const id = readFileSync(machineIdPath, 'utf-8').trim();
    if (id) {
      return `linux:${id}`;
    }
  }

  // Fallback to /var/lib/dbus/machine-id (older systems)
  const dbusPath = '/var/lib/dbus/machine-id';
  if (existsSync(dbusPath)) {
    const id = readFileSync(dbusPath, 'utf-8').trim();
    if (id) {
      return `linux:${id}`;
    }
  }

  throw new Error('Could not find machine-id file');
}

function getFallbackMachineId(): string {
  // Use hostname + platform as a last resort
  // This is less stable (changes if hostname changes) but provides some uniqueness
  return `fallback:${process.platform}:${hostname()}`;
}
