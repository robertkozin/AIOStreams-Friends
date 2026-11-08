import { baseOptions, Preset } from './preset.js';
import { constants } from '../utils/index.js';
import { config as appConfig } from '../config/index.js';
import { Addon, Option, UserData } from '../db/index.js';
import {
  NZBGEEK_FEEDS,
  NZBGEEK_MAX_SIZE,
  NzbgeekConfigSchema,
} from '../builtins/nzbgeek/addon.js';

/** Saved feeds since dropped from NZBGEEK_FEEDS are left out; none means all. */
function knownFeeds(feeds: unknown): string[] | undefined {
  const known = Array.isArray(feeds)
    ? feeds.filter((feed) => Object.hasOwn(NZBGEEK_FEEDS, feed))
    : [];
  return known.length ? known : undefined;
}

export class NzbgeekPreset extends Preset {
  static override get METADATA() {
    const supportedResources = [constants.CATALOG_RESOURCE];

    const options: Option[] = [
      ...baseOptions(
        'NZBgeek',
        supportedResources,
        appConfig.presets.defaultTimeout
      ).filter((option) => option.id !== 'url'),
      {
        id: 'apiKey',
        name: 'API Key',
        description:
          'Your NZBgeek API key, the `r=` value of its RSS links, shown on your NZBgeek profile.',
        type: 'password',
        required: true,
      },
      {
        id: 'feeds',
        name: 'Catalogs',
        description: 'Which NZBgeek lists to show as catalogs.',
        type: 'multi-select',
        required: false,
        default: Object.keys(NZBGEEK_FEEDS),
        options: Object.entries(NZBGEEK_FEEDS).map(([value, feed]) => ({
          value,
          label: `${feed.name} (${feed.type === 'movie' ? 'Movies' : 'Series'})`,
        })),
      },
      {
        id: 'size',
        name: 'Size',
        description: `How many items each catalog lists, up to ${NZBGEEK_MAX_SIZE}.`,
        type: 'number',
        required: false,
        default: 100,
        constraints: { min: 1, max: NZBGEEK_MAX_SIZE },
      },
      {
        id: 'cacheHours',
        name: 'Cache (hours)',
        description:
          'How long each list is kept before NZBgeek is asked again.',
        type: 'number',
        required: false,
        default: 24,
        constraints: { min: 1 },
      },
    ];

    return {
      ID: 'nzbgeek',
      NAME: 'NZBgeek',
      LOGO: 'https://api.nzbgeek.info/covers/nzbgeek.png',
      URL: [`${appConfig.bootstrap.internalUrl}/builtins/nzbgeek`],
      TIMEOUT: appConfig.presets.defaultTimeout,
      USER_AGENT: appConfig.http.defaultUserAgent,
      SUPPORTED_SERVICES: [],
      DESCRIPTION:
        "Catalogs from NZBgeek's new, trending, top rated and endorsed movie and TV lists.",
      OPTIONS: options,
      SUPPORTED_STREAM_TYPES: [],
      SUPPORTED_RESOURCES: supportedResources,
      BUILTIN: true,
      CATEGORY: constants.PresetCategory.META_CATALOGS,
    };
  }

  static async generateAddons(
    userData: UserData,
    options: Record<string, any>
  ): Promise<Addon[]> {
    if (!options.apiKey)
      throw new Error(`${this.METADATA.NAME} needs your NZBgeek API key.`);
    const config = NzbgeekConfigSchema.parse({
      apiKey: options.apiKey,
      feeds: knownFeeds(options.feeds),
      size: options.size ? Number(options.size) : undefined,
      cacheHours: options.cacheHours ? Number(options.cacheHours) : undefined,
    });
    return [
      {
        name: options.name || this.METADATA.NAME,
        manifestUrl: `${this.DEFAULT_URL}/${this.base64EncodeJSON(config, 'urlSafe')}/manifest.json`,
        enabled: true,
        library: false,
        resources: options.resources || this.METADATA.SUPPORTED_RESOURCES,
        timeout: options.timeout || this.METADATA.TIMEOUT,
        preset: {
          id: '',
          type: this.METADATA.ID,
          options: options,
        },
        headers: {
          'User-Agent': this.METADATA.USER_AGENT,
        },
      },
    ];
  }
}
