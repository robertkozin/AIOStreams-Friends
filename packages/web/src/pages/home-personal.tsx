/* eslint-disable lingui/no-unlocalized-strings -- this fork's home page is English only, to keep the locale files untouched */
import React from 'react';
import {
  BiChevronRight,
  BiCompass,
  BiGroup,
  BiHistory,
  BiSearch,
} from 'react-icons/bi';
import { Button } from '@aiostreams/ui/button';
import { useSession } from '../lib/session';
import {
  mergeRows,
  useItemPages,
  useNextUp,
  useResume,
  useUpcoming,
} from '../lib/queries';
import { cardImages, cardShape, animatedPosterOf } from '../lib/images';
import { itemSubtitle, progressOf } from '../lib/format';
import { href, itemPath, navigate, to } from '../lib/paths';
import { MediaRow } from '../components/media-row';
import { PosterCard } from '../components/cards';
import { ItemMenu } from '../components/item-menu';
import { Anchor } from '../components/anchor';
import { PageBody } from '../components/layout';
import { openPartySheet } from '../components/party/party-sheet';
import type { BaseItemDto } from '../lib/types';
import { EpisodeRow, UpcomingRow } from './home';

/**
 * A home page of what the user watches: no catalogs, no hero. Discovering is
 * the Discover page's job. Kept apart from home.tsx to leave it to upstream.
 */
export function HomePage() {
  const { user } = useSession();
  const resume = useResume();
  const nextUp = useNextUp();
  const upcoming = useUpcoming();
  const favourites = useItemPages('', {
    filter: 'favorite',
    types: 'Movie,Series',
    recursive: true,
    pageSize: 20,
  });
  const continueItems = React.useMemo(
    () => mergeRows(resume.data?.Items, nextUp.data?.Items),
    [resume.data, nextUp.data]
  );
  const favouriteItems = favourites.data?.pages.flatMap((p) => p.Items ?? []);

  const loading =
    resume.isLoading ||
    nextUp.isLoading ||
    upcoming.isLoading ||
    favourites.isLoading;
  const returning =
    !!continueItems.length ||
    !!upcoming.data?.Items?.length ||
    !!favouriteItems?.length;
  const empty =
    !loading &&
    !continueItems.length &&
    !upcoming.data?.Items?.length &&
    !favouriteItems?.length;

  return (
    <PageBody>
      <div data-ui="home-rows" className="space-y-10">
        <header className="space-y-6">
          <h1 data-ui="page-title" className="text-3xl font-bold">
            {`${returning ? 'Welcome back' : 'Welcome'}${user.Name ? `, ${user.Name}` : ''}`}
          </h1>
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 scrollbar-hide lg:mx-0 lg:flex-wrap lg:px-0">
            <Button
              size="sm"
              intent="gray-subtle"
              className="shrink-0 rounded-full"
              leftIcon={<BiSearch />}
              onClick={() => navigate(to.search())}
            >
              Search
            </Button>
            <Button
              size="sm"
              intent="gray-subtle"
              className="shrink-0 rounded-full"
              leftIcon={<BiCompass />}
              onClick={() => navigate(to.discover())}
            >
              Discover
            </Button>
            <Button
              size="sm"
              intent="gray-subtle"
              className="shrink-0 rounded-full"
              leftIcon={<BiGroup />}
              onClick={() => openPartySheet()}
            >
              Watch together
            </Button>
          </div>
        </header>
        {empty ? (
          <p className="text-[--muted]">
            Nothing to show yet. Things you watch and favourite will appear
            here.
          </p>
        ) : (
          <>
            {(loading || !!continueItems.length) && (
              <EpisodeRow
                id="resume"
                title={'Continue watching'}
                items={continueItems}
                loading={resume.isLoading || nextUp.isLoading}
                action={
                  <Button
                    size="sm"
                    intent="gray-subtle"
                    className="rounded-full"
                    leftIcon={<BiHistory />}
                    onClick={() => navigate(to.history)}
                  >
                    Activity
                  </Button>
                }
              />
            )}
            {!!upcoming.data?.Items?.length && <UpcomingRow />}
            {(favourites.isLoading || !!favouriteItems?.length) && (
              <FavouritesRow
                items={favouriteItems}
                loading={favourites.isLoading}
              />
            )}
          </>
        )}
      </div>
    </PageBody>
  );
}

function FavouritesRow({
  items,
  loading,
}: {
  items: BaseItemDto[] | undefined;
  loading: boolean;
}) {
  const { client } = useSession();
  return (
    <MediaRow
      id="favourites"
      shape="poster"
      loading={loading}
      title={
        <Anchor
          href={href(to.favourites())}
          className="group/title inline-flex items-baseline gap-2"
        >
          Favourites
          <BiChevronRight className="self-center text-xl text-[--muted] transition-transform group-hover/title:translate-x-0.5 rtl:-scale-x-100 rtl:group-hover/title:-translate-x-0.5" />
        </Anchor>
      }
    >
      {items?.map((item) => (
        <ItemMenu key={item.Id} item={item}>
          <PosterCard
            href={href(itemPath(item))}
            shape={cardShape(item)}
            image={(width) =>
              cardImages(client, item, cardShape(item), { maxWidth: width })
            }
            animated={animatedPosterOf(item)}
            title={item.Name ?? ''}
            subtitle={itemSubtitle(item)}
            itemType={item.Type}
            watched={item.UserData?.Played}
            favourite={item.UserData?.IsFavorite}
            unwatched={item.UserData?.UnplayedItemCount ?? undefined}
            progress={progressOf(item)}
          />
        </ItemMenu>
      ))}
    </MediaRow>
  );
}
