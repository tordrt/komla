import { IPC } from '../../constants/ipc-channels';
import {
  remoteControlDisconnectActiveArgsSchema,
  remoteControlDirectStartArgsSchema,
  remoteControlHostAccessSetArgsSchema,
  pairedDevicesRenameArgsSchema,
  pairedDevicesRemoveArgsSchema,
} from '../schemas/remote-control-ipc.schemas';

import { invoke } from './define';

import type { PairedDeviceRecord } from '../../types/paired-device';
import type {
  RemoteControlDirectPairingOffer,
  RemoteControlDirectServerInfo,
  RemoteControlDirectState,
  RemoteControlDirectTailscaleServeResult,
  RemoteControlDirectTailscaleStatus,
  RemoteControlHostAccessStatus,
} from '../../types/remote-control';

export const remoteControlContract = {
  [IPC.REMOTE_CONTROL_DISCONNECT_ACTIVE]: invoke(
    remoteControlDisconnectActiveArgsSchema
  ).returns<void>(),
  [IPC.REMOTE_CONTROL_DIRECT_START]: invoke(
    remoteControlDirectStartArgsSchema
  ).returns<RemoteControlDirectServerInfo>(),
  [IPC.REMOTE_CONTROL_DIRECT_STOP]: invoke().returns<void>(),
  [IPC.REMOTE_CONTROL_DIRECT_START_PAIRING]: invoke(
    remoteControlDirectStartArgsSchema
  ).returns<RemoteControlDirectPairingOffer>(),
  [IPC.REMOTE_CONTROL_DIRECT_START_TAILSCALE_SERVE]: invoke(
    remoteControlDirectStartArgsSchema
  ).returns<RemoteControlDirectTailscaleServeResult>(),
  [IPC.REMOTE_CONTROL_DIRECT_GET_TAILSCALE_STATUS]:
    invoke().returns<RemoteControlDirectTailscaleStatus>(),
  [IPC.REMOTE_CONTROL_DIRECT_CANCEL_PAIRING]: invoke().returns<void>(),
  [IPC.REMOTE_CONTROL_DIRECT_GET_STATE]: invoke().returns<RemoteControlDirectState>(),
  [IPC.PAIRED_DEVICES_LIST]: invoke().returns<PairedDeviceRecord[]>(),
  [IPC.REMOTE_CONTROL_HOST_ACCESS_LIST]: invoke().returns<RemoteControlHostAccessStatus[]>(),
  [IPC.REMOTE_CONTROL_HOST_ACCESS_SET]: invoke(
    remoteControlHostAccessSetArgsSchema
  ).returns<RemoteControlHostAccessStatus>(),
  [IPC.PAIRED_DEVICES_RENAME]: invoke(pairedDevicesRenameArgsSchema).returns<PairedDeviceRecord>(),
  [IPC.PAIRED_DEVICES_REMOVE]: invoke(pairedDevicesRemoveArgsSchema).returns<void>(),
} as const;
