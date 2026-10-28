declare const __KOMLA_ENV__: string;

const env = typeof __KOMLA_ENV__ !== 'undefined' ? __KOMLA_ENV__ : 'staging';

const URLS = {
  staging: {
    api: 'https://test.komla.dev',
    utility: 'https://utility.komla.dev',
    downloads: 'https://downloads.komla.dev/staging',
  },
  production: {
    api: 'https://komla.dev',
    utility: 'https://utility.komla.dev',
    downloads: 'https://downloads.komla.dev',
  },
};

const config = URLS[env as keyof typeof URLS] || URLS.staging;

export const API_BASE_URL = process.env.KOMLA_API_URL || config.api;
export const UTILITY_BASE_URL = process.env.KOMLA_UTILITY_URL || config.utility;
export const DOWNLOADS_BASE_URL = config.downloads;
