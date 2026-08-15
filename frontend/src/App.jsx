import React from 'react';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import PlaylistDetail from './pages/PlaylistDetail';
import NewPlaylist from './pages/NewPlaylist';
import Recommendations from './pages/Recommendations';
import Settings from './pages/Settings';
import './app.css';

export default function App() {
  return (
    <BrowserRouter>
      <div className="app">
        <nav className="sidebar">
          <div className="sidebar-logo">
            <span className="logo-icon">🎵</span>
            <span className="logo-text">Tunecraft</span>
          </div>
          <NavLink to="/" end className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            📻 Playlists
          </NavLink>
          <NavLink to="/new" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            ➕ New Playlist
          </NavLink>
          <NavLink to="/recommendations" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            🔍 Recommendations
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            ⚙️ Settings
          </NavLink>
        </nav>
        <main className="main-content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/playlists/:id" element={<PlaylistDetail />} />
            <Route path="/new" element={<NewPlaylist />} />
            <Route path="/recommendations" element={<Recommendations />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
