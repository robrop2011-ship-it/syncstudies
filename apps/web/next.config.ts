import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV === 'development';

/**
 * Avatars live on their own origin (R2 / a CDN domain). Parsed once here so a
 * malformed value fails the build rather than emitting a broken CSP at runtime.
 */
const avatarOrigin = (() => {
  const raw = process.env.NEXT_PUBLIC_AVATAR_BASE_URL;
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    throw new Error(`NEXT_PUBLIC_AVATAR_BASE_URL is not a valid URL: ${raw}`);
  }
})();

/**
 * Content-Security-Policy (PLAN.md §11.6).
 *
 * Kept as a directive map rather than one long string so tightening a single
 * directive is a one-line diff and so the "why" of each entry stays attached to it.
 *
 * Honest note on `script-src 'unsafe-inline'`: the App Router streams its RSC
 * payload through inline `<script>` tags, and the pre-paint theme script in
 * app/layout.tsx is inline by necessity (it must run before first paint or the
 * page flashes the wrong theme). Both need either `'unsafe-inline'` or a
 * per-request nonce, and a nonce requires `middleware.ts` to generate one and
 * `headers()` to read it back — that middleware is not part of this slice.
 * Everything else here is already at its final strictness.
 */
const csp: Record<string, string[]> = {
  'default-src': ["'self'"],
  'script-src': [
    "'self'",
    "'unsafe-inline'",
    // The IFrame Player API loader and the player bundle it pulls in.
    'https://www.youtube.com',
    'https://s.ytimg.com',
    // React Refresh compiles component modules with eval in dev only.
    ...(isDev ? ["'unsafe-eval'"] : []),
  ],
  // next/font self-hosts Inter, so no font CDN is needed. Inline styles come from
  // Next's own critical-CSS injection.
  'style-src': ["'self'", "'unsafe-inline'"],
  'font-src': ["'self'", 'data:'],
  // Only the YouTube embed may be framed. `youtube-nocookie` is the default we use.
  'frame-src': ['https://www.youtube-nocookie.com', 'https://www.youtube.com'],
  // Video thumbnails come from i.ytimg.com. Avatars are deliberately served from a
  // separate origin (§11.8 — never serve user uploads from the app's origin), so
  // that origin has to be allowed here or every uploaded avatar is silently
  // blocked and falls back to the generated initial.
  'img-src': ["'self'", 'data:', 'https://i.ytimg.com', ...(avatarOrigin ? [avatarOrigin] : [])],
  // The realtime service is reached over ws/wss; REST is same-origin.
  'connect-src': ["'self'", 'ws:', 'wss:'],
  'media-src': ["'self'", 'blob:'],
  'worker-src': ["'self'", 'blob:'],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
};

const cspHeader = Object.entries(csp)
  .map(([directive, values]) => `${directive} ${values.join(' ')}`)
  .join('; ');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // Workspace packages are published as TypeScript source (main → src/index.ts),
  // so the bundler has to compile them rather than treat them as pre-built deps.
  transpilePackages: ['@syncstudy/shared', '@syncstudy/auth', '@syncstudy/db'],

  /**
   * Packages that must be `require`d at runtime rather than bundled.
   *
   * `@node-rs/argon2` resolves to a platform-specific `.node` binary, which
   * webpack has no loader for — it is reached through @syncstudy/auth, which IS
   * transpiled, so it has to be excluded explicitly. Prisma is listed for the
   * same reason (it ships a native query engine).
   */
  serverExternalPackages: ['@node-rs/argon2', '@prisma/client'],

  webpack: (config, { isServer }) => {
    // `serverExternalPackages` alone does not cover a native module reached
    // THROUGH a `transpilePackages` entry (@syncstudy/auth → @node-rs/argon2),
    // so webpack still follows it down to a `.node` binary it cannot parse.
    // Marking it external on the server build emits a plain `require()` instead.
    if (isServer) {
      const existing = Array.isArray(config.externals)
        ? config.externals
        : config.externals
          ? [config.externals]
          : [];
      config.externals = [...existing, '@node-rs/argon2'];
    }
    return config;
  },


  eslint: { dirs: ['app', 'components', 'lib'] },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: cspHeader },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          {
            key: 'Permissions-Policy',
            // The three the product actually uses stay self-scoped; the rest are off.
            value: [
              'camera=(self)',
              'microphone=(self)',
              'display-capture=(self)',
              'geolocation=()',
              'payment=()',
              'usb=()',
              'interest-cohort=()',
            ].join(', '),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
