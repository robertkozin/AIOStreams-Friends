import {
  accountScope,
  JellyfinRepository,
  type WatchScope,
} from '@aiostreams/core';

/** The web app's synced settings, stored as one display-preferences entry. */
const WEB_PREFS = 'aiostreams-web';
/** Settings a persona takes from the account until it saves its own. */
const INHERITED = ['versionFilters'] as const;
/** The web app's mark that a user's settings were saved, rather than never set. */
const SAVED_MARK = 'saved';

type Prefs = Record<string, unknown> | null;

/**
 * A persona with its own history starts with the account's quick filters, and
 * keeps following them until it saves a set of its own.
 */
export async function withAccountDefaults(
  watch: WatchScope,
  id: string,
  client: string,
  stored: Prefs
): Promise<Prefs> {
  const account = accountScope(watch.uuid);
  if (id !== WEB_PREFS || client !== WEB_PREFS) return stored;
  if (watch.persona === account.persona) return stored;
  const own = (stored?.CustomPrefs ?? {}) as Record<string, unknown>;
  const missing = INHERITED.filter((key) => !own[key]);
  if (!missing.length) return stored;
  const theirs = (await JellyfinRepository.getDisplayPrefs(account, id, client))
    ?.CustomPrefs as Record<string, unknown> | undefined;
  const inherited = Object.fromEntries(
    missing.flatMap((key) => (theirs?.[key] ? [[key, theirs[key]]] : []))
  );
  if (!Object.keys(inherited).length) return stored;
  return {
    ...(stored ?? {}),
    CustomPrefs: {
      // Else a persona with nothing saved keeps its device's settings instead.
      ...(!stored && { [SAVED_MARK]: '1' }),
      ...own,
      ...inherited,
    },
  };
}
