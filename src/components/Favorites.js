import React, { memo, useCallback, useContext, useMemo } from 'react';
import FavoriteButton from './FavoriteButton';
import DirectoryLink from './DirectoryLink';
import { UserContext } from './UserProvider';
import VirtualizedList from './VirtualizedList';
import bytes from 'bytes';

// Same escaping as Browse: %/# must be pre-escaped for react-router.
function browseHref(path) {
  return '/browse/' + path.replace(/%/g, '%25').replace(/#/g, '%23');
}

const FavoriteRow = (props) => {
  const { item, onPlay } = props;

  if (item.type === 'directory') {
    return (
      <div className="BrowseList-colName">
        <DirectoryLink dim to={item.href}>{item.name}</DirectoryLink>
      </div>
    );
  }

  const { href, mtime, size, name } = item;
  const date = new Date(mtime * 1000).toISOString().split('T')[0];

  return (
    <>
      <div className="BrowseList-colName">
        <FavoriteButton item={item}/>
        <a onClick={onPlay} href={href}>{name}</a>
      </div>
      <div className="BrowseList-colMtime">
        {date}
      </div>
      <div className="BrowseList-colSize">
        {bytes(size, { unitSeparator: ' ' })}
      </div>
    </>
  )
};

/**
 * Group favorites under the path that contains them: a single-song file is
 * listed under its directory, and a sub-song under its song folder (the parent
 * file). This mirrors Browse (path above, songs below) and Search. The original
 * favorite order is preserved within each group, and `idx` still points into
 * the unfiltered favorites context.
 */
function favoritesToListing(faves) {
  const sep = '/';
  const decorated = faves.map((fave, i) => {
    const path = fave.path;
    const subtune = fave.subtune || 0;
    const isSongFolder = (fave.subtuneCount || 1) > 1;
    const dir = path.split(sep).slice(0, -1).join(sep);
    const filename = path.split(sep).pop();
    return {
      ...fave,
      idx: i,
      type: 'file',
      container: isSongFolder ? path : dir,
      isSongFolder,
      name: isSongFolder ? (fave.subtuneTitle || `Tune ${subtune + 1}`) : filename,
    };
  });

  // Group by container; within a directory keep the user's favorite order, but
  // order a song folder's sub-tunes numerically (so Tune 2 precedes Tune 6).
  decorated.sort((a, b) => {
    const byContainer = a.container.localeCompare(b.container);
    if (byContainer !== 0) return byContainer;
    return a.isSongFolder && b.isSongFolder ? a.subtune - b.subtune : 0;
  });

  const rows = [];
  let curr;
  for (const item of decorated) {
    if (item.container !== curr) {
      curr = item.container;
      rows.push({
        type: 'directory',
        href: browseHref(item.container),
        name: item.container
          ? (item.isSongFolder ? item.container : `${item.container}/`)
          : '/',
      });
    }
    rows.push(item);
  }
  return rows;
}

export default memo(Favorites);

function Favorites(props) {
  const {
    scrollContainerRef,
    currContext,
    currIdx,
    onSongClick,
    handleShufflePlay,
    listRef,
  } = props;

  const {
    user,
    loadingUser,
    faves,
    favesContext,
    handleLogin,
  } = useContext(UserContext);

  const rows = useMemo(() => favoritesToListing(faves), [faves]);

  const handleShufflePlayFavorites = useCallback(() => {
    handleShufflePlay('favorites');
  }, [handleShufflePlay]);

  if (loadingUser && faves.length === 0) {
    return <p>Loading user data...</p>;
  }

  if (!scrollContainerRef.current) {
    return <p>Loading...</p>;
  }

  if (!user && faves.length === 0) {
    return (
      <span>
        You must <a href="#" onClick={handleLogin}>
        login or signup</a> to save favorites.
      </span>
    );
  }

  return (
    <VirtualizedList
      {...{
        scrollContainerRef,
        currContext,
        currIdx,
        onSongClick,
        listRef,
        itemList: rows,
        songContext: favesContext,
        rowRenderer: FavoriteRow,
      }}
    >
      <h3 className="Browse-topRow">
        Favorite Songs ({faves.length})
        {faves.length > 1 &&
          <button
            className="box-button"
            title={`Shuffle all ${faves.length} favorites`}
            onClick={handleShufflePlayFavorites}>
            Shuffle Play
          </button>}
      </h3>
      {faves.length === 0 &&
        <div style={{ padding: '0 1em' }}>
          You don't have any favorites yet.<br/>
          Click the &#003; heart icon next to any song to save a favorite.
        </div>}
    </VirtualizedList>
  );
}
