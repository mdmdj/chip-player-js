import React, { memo, useCallback, useRef } from 'react';
import { FORMATS } from '../config';
import { songRefListsEqual } from '../util';
import bytes from 'bytes';

const formatList = FORMATS.filter(f => f !== 'miniusf' && f !== 'minigsf').map(f => `.${f}`);
const splitPoint = Math.floor(formatList.length / 2);
const formatsLine1 = formatList.slice(0, splitPoint).join(' ');
const formatsLine2 = formatList.slice(splitPoint).join(' ');

export default memo(LocalFiles);

function LocalFiles(props) {
  const {
    listing,
    currContext,
    playContext,
    currIdx,
    onSongClick,
    onDelete,
    onAddFiles,
    loading,
  } = props;
  const fileInputRef = useRef(null);

  const handleDelete = useCallback((event) => {
    const href = event.currentTarget.dataset.href;
    if (event.shiftKey) {
      onDelete(href);
    } else {
      if (window.confirm('Are you sure you want to remove this file from browser storage?\n(Shift-click to remove without confirmation.)'))
        onDelete(href);
    }
  }, [onDelete]);

  const handleAddClick = () => {
    fileInputRef.current.click();
  };

  const handleFileChange = (event) => {
    const files = event.target.files;
    if (files.length > 0) {
      onAddFiles([...files]);
    }
  };

  const handleClear = () => {
    if (window.confirm('Are you sure you want to remove ALL local files?\nThis cannot be undone.')) {
      onDelete(listing.map(item => item.path));
    }
  }

  const isCurrentContext = songRefListsEqual(currContext, playContext);

  return (
    <div>
      <h3 className="Browse-topRow">
        Local Files ({new Set(listing.map(item => item.path)).size})
        <div className='button-container'>
          <button className='box-button' onClick={handleAddClick} title='Add files'>
            Add Files...
          </button>
          {' '}
          {listing.length > 0 &&
            <button className='box-button' onClick={handleClear} title='Remove all local files'>
              Clear
            </button>
          }
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={formatList.join(',')}
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
      </h3>
      {loading ?
        <div className='LocalFiles-message'>Loading local files...</div>
        :
        listing.length === 0 ?
          <div>
            <p>
              You don't have any Local Files yet.
            </p>
            <p>
              Files dropped here will be persisted in your local browser.<br/>
              (Keep a copy - your browser might lose this data.)<br/>
              Local Files can't be added to Favorites.
            </p>
            <p>
              Supported formats:
            </p>
            <p>
              {formatsLine1}<br/>
              {formatsLine2}<br/>
            </p>
          </div>
          :
          <div>
            {
              listing.map((item) => {
                const href = item.path;
                // A multi-song file is a virtual folder: a header row (the file,
                // with the delete button) and one row per sub-tune beneath it.
                if (item.type === 'folder') {
                  return (
                    <React.Fragment key={href}>
                      <div className="BrowseList-row">
                        <button className='Trash-button' title='Delete' onClick={handleDelete} data-href={href}>
                          <span className='inline-icon icon-trash'/>
                        </button>
                        <div className="BrowseList-colName">{item.name}</div>
                        <div className="BrowseList-colDir">&lt;TUNES&gt;</div>
                        <div className="BrowseList-colCount"
                             title={`Contains ${item.children.length} sub-tunes`}>
                          {item.children.length}
                        </div>
                        <div className="BrowseList-colMtime">
                          {item.mtime}
                        </div>
                        <div className="BrowseList-colSize">
                          {bytes(item.size, { unitSeparator: ' ' })}
                        </div>
                      </div>
                      {item.children.map((child) => {
                        const isPlaying = isCurrentContext && currIdx === child.ctxIdx;
                        return (
                          <div key={`${href}#${child.subtune}`}
                               className={`BrowseList-row LocalFiles-subtune${isPlaying ? ' Song-now-playing' : ''}`}>
                            {/* Same width as the header's trash button, so names line up. */}
                            <button className='Trash-button' tabIndex={-1} aria-hidden='true' style={{ visibility: 'hidden' }}>
                              <span className='inline-icon icon-trash'/>
                            </button>
                            <div className="BrowseList-colName">
                              <a onClick={onSongClick(href, playContext, child.ctxIdx)} href={href}>{child.name}</a>
                            </div>
                          </div>
                        );
                      })}
                    </React.Fragment>
                  );
                }
                const isPlaying = isCurrentContext && currIdx === item.ctxIdx;
                return (
                  <div key={`${href}#${item.subtune || 0}`} className={isPlaying ? 'Song-now-playing BrowseList-row' : 'BrowseList-row'}>
                    <button className='Trash-button' title='Delete' onClick={handleDelete} data-href={href}>
                      <span className='inline-icon icon-trash'/>
                    </button>
                    <div className="BrowseList-colName">
                      <a onClick={onSongClick(href, playContext, item.ctxIdx)} href={href}>{item.name}</a>
                    </div>
                    <div className="BrowseList-colMtime">
                      {item.mtime}
                    </div>
                    <div className="BrowseList-colSize">
                      {bytes(item.size, { unitSeparator: ' ' })}
                    </div>
                    <button className='Trash-button' title='Delete' onClick={handleDelete} data-href={href}>
                      <span className='inline-icon icon-trash'/>
                    </button>
                  </div>
                );
              })
            }
          </div>
      }
    </div>
  );
}
