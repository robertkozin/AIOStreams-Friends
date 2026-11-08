import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import '../../index.js';
import { metaOf, parseFeed, splitYear } from './addon.js';

const rss = (items: string) =>
  `<?xml version="1.0" encoding="utf-8" ?><rss version="2.0"><channel><title>api.nzbgeek.info</title>${items}</channel></rss>`;

describe('parseFeed', () => {
  it('reads the id the feed type carries', () => {
    const xml = rss(
      '<item><title>Dune (2021)</title><imdbid>01160419</imdbid><coverurl>https://api.nzbgeek.info/covers/movies/01160419-cover.jpg</coverurl></item>' +
        '<item><title>No id</title></item>' +
        '<item><title>Geek Movie Graveyard ()</title><imdbid>00000000</imdbid></item>' +
        '<item><title>Savage Prey ()</title><imdbid>1234567</imdbid></item>'
    );
    assert.deepEqual(parseFeed(xml, 'trending_movies'), [
      {
        title: 'Dune (2021)',
        id: '01160419',
        poster: 'https://api.nzbgeek.info/covers/movies/01160419-cover.jpg',
      },
      { title: 'Savage Prey', id: '1234567', poster: undefined },
    ]);
    const shows = rss(
      '<item><title>South Park</title><tvdbid>75897</tvdbid></item>'
    );
    assert.deepEqual(parseFeed(shows, 'trending_shows'), [
      { title: 'South Park', id: '75897', poster: undefined },
    ]);
  });

  it('throws the error NZBgeek answers with', () => {
    assert.throws(
      () =>
        parseFeed(
          '<error code="102" description="Invalid API Key"/>',
          'trending_shows'
        ),
      /Invalid API Key/
    );
  });
});

describe('metaOf', () => {
  it('makes movie ids IMDb ids and splits off the year', () => {
    assert.deepEqual(
      metaOf('movie', { title: 'The Godfather (1972)', id: '00068646' }),
      {
        id: 'tt0068646',
        type: 'movie',
        name: 'The Godfather',
        poster: undefined,
        posterShape: 'poster',
        releaseInfo: '1972',
      }
    );
    assert.equal(
      metaOf('movie', { title: 'The Odyssey 2026', id: '33764258' }).id,
      'tt33764258'
    );
    assert.equal(
      metaOf('movie', { title: 'The Odyssey 2026', id: '33764258' }).name,
      'The Odyssey'
    );
  });

  it('splits the year off a show title, but not a title that is a year', () => {
    assert.deepEqual(splitYear('Doctor Who 2005'), {
      name: 'Doctor Who',
      year: '2005',
    });
    assert.deepEqual(splitYear('1923'), { name: '1923' });
  });
});
