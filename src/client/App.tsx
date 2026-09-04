import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api.js';
import { Browse } from './pages/Browse.js';
import { Library } from './pages/Library.js';
import { Reader } from './pages/Reader.js';
import { Series } from './pages/Series.js';
import { Updates } from './pages/Updates.js';

function TabBar({ updateCount }: { updateCount: number }) {
  const tabs = [
    { to: '/', glyph: '▦', label: 'Library', end: true },
    { to: '/updates', glyph: '↻', label: 'Updates', badge: updateCount },
    { to: '/browse', glyph: '⌕', label: 'Browse' },
  ];
  return (
    <nav className="tabbar">
      {tabs.map((tab) => (
        <NavLink key={tab.to} to={tab.to} end={tab.end}>
          <span className="glyph">
            {tab.glyph}
            {tab.badge ? <span className="badge">{tab.badge > 99 ? '99+' : tab.badge}</span> : null}
          </span>
          <span>{tab.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

export function App() {
  const location = useLocation();
  const [updateCount, setUpdateCount] = useState(0);
  const inReader = location.pathname.startsWith('/read/');

  // Keep the Updates badge roughly current without polling aggressively.
  useEffect(() => {
    if (inReader) return;
    let cancelled = false;
    const refresh = () => {
      api
        .updates()
        .then((data) => {
          if (!cancelled) setUpdateCount(data.entries.length);
        })
        .catch(() => {
          /* badge is cosmetic; a failure here should not surface an error */
        });
    };
    refresh();
    const timer = setInterval(refresh, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [inReader, location.pathname]);

  if (inReader) {
    return (
      <Routes>
        <Route path="/read/:chapterId" element={<Reader />} />
      </Routes>
    );
  }

  return (
    <div className="app">
      <Routes>
        <Route path="/" element={<Library />} />
        <Route path="/updates" element={<Updates />} />
        <Route path="/browse" element={<Browse />} />
        <Route path="/series/:seriesId" element={<Series />} />
        <Route path="*" element={<div className="content empty"><h2>Page not found</h2></div>} />
      </Routes>
      <TabBar updateCount={updateCount} />
    </div>
  );
}
