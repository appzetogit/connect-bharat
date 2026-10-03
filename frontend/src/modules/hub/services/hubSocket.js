import { useEffect } from 'react';
import { io } from 'socket.io-client';
import { BACKEND_ORIGIN } from '../../../shared/api/runtimeConfig';
import { hubSession } from './hubApi';

/**
 * One socket per panel session, authenticated with the hub token. The server
 * puts it in `hub:<hubId>` for every hub the staff member can act for, and
 * emits `logistics:shipment:updated` / `logistics:manifest:updated` there.
 */
let socket = null;

const getSocket = () => {
  const token = hubSession.getToken();
  if (!token) return null;
  if (socket && socket.auth?.token === token) return socket;
  if (socket) socket.disconnect();
  socket = io(import.meta.env.VITE_SOCKET_URL || BACKEND_ORIGIN, {
    auth: { token },
    transports: ['websocket', 'polling'],
  });
  return socket;
};

export const disconnectHubSocket = () => {
  if (socket) socket.disconnect();
  socket = null;
};

/** Calls [handler] on every shipment/manifest update for my hubs. */
export const useHubLiveUpdates = (handler) => {
  useEffect(() => {
    const live = getSocket();
    if (!live) return undefined;
    const onShipment = (payload) => handler?.({ kind: 'shipment', ...payload });
    const onManifest = (payload) => handler?.({ kind: 'manifest', ...payload });
    live.on('logistics:shipment:updated', onShipment);
    live.on('logistics:manifest:updated', onManifest);
    return () => {
      live.off('logistics:shipment:updated', onShipment);
      live.off('logistics:manifest:updated', onManifest);
    };
  }, [handler]);
};
