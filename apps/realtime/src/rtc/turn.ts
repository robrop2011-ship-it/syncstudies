/**
 * TURN credential minting (PLAN.md §9.3).
 *
 * coturn's REST-API mechanism: the username is `<unix-expiry>:<userId>` and the
 * credential is `base64(HMAC-SHA1(username, static-auth-secret))`. coturn
 * recomputes the same HMAC and checks the expiry, so no credential is ever
 * stored anywhere and every one of them dies on its own.
 *
 * The rule this file exists to enforce: **a static TURN username/password is
 * never sent to a browser.** Anyone with devtools would then own a free relay,
 * and a 20 TB allowance becomes somebody's torrent box. If `TURN_SECRET` is
 * absent — which is the normal state in dev — we ship STUN only and calling
 * degrades to "works unless both peers are behind symmetric NAT" rather than
 * shipping a shared password to make it look like it works.
 */
import { createHmac } from 'node:crypto';
import { TURN_CREDENTIAL_TTL_SEC, type IceServerConfig } from '@syncstudy/shared';

export interface TurnConfig {
  TURN_SECRET?: string | undefined;
  TURN_URLS?: string[] | undefined;
  STUN_URLS: string[];
}

export interface IceGrant {
  iceServers: IceServerConfig[];
  ttlSec: number;
}

/**
 * Mint an ICE configuration for one user.
 *
 * `nowMs` is a parameter rather than a `Date.now()` call so the credential
 * arithmetic is testable without freezing the clock globally.
 */
export function mintIceServers(
  config: TurnConfig,
  userId: string,
  nowMs: number = Date.now(),
): IceGrant {
  const iceServers: IceServerConfig[] = [];

  if (config.STUN_URLS.length > 0) {
    iceServers.push({ urls: config.STUN_URLS });
  }

  const secret = config.TURN_SECRET;
  const turnUrls = config.TURN_URLS ?? [];
  if (secret !== undefined && secret.length > 0 && turnUrls.length > 0) {
    const expiry = Math.floor(nowMs / 1000) + TURN_CREDENTIAL_TTL_SEC;
    const username = `${expiry}:${userId}`;
    const credential = createHmac('sha1', secret).update(username).digest('base64');
    iceServers.push({ urls: turnUrls, username, credential });
  }

  return { iceServers, ttlSec: TURN_CREDENTIAL_TTL_SEC };
}

/** True when this deployment can relay. Used to decide whether to warn on join. */
export function hasTurn(config: TurnConfig): boolean {
  return (
    config.TURN_SECRET !== undefined &&
    config.TURN_SECRET.length > 0 &&
    (config.TURN_URLS ?? []).length > 0
  );
}
