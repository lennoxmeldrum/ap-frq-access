import React from 'react';
import { Link, useLocation } from 'react-router-dom';

const Header: React.FC = () => {
  const location = useLocation();
  const isHome = location.pathname === '/';

  return (
    <header className="bg-white border-b border-gray-200">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-4">
        <Link to="/" className="flex items-center gap-3 group">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-white font-bold shadow-sm">
            FRQ
          </div>
          <div className="leading-tight">
            <div className="text-base sm:text-lg font-semibold text-gray-900 group-hover:text-indigo-700 transition-colors">
              AP FRQ Archive
            </div>
            <div className="text-xs text-gray-500 hidden sm:block">
              Browse AI-generated AP free response questions
            </div>
          </div>
        </Link>
        {!isHome && (
          <Link
            to="/"
            className="text-sm font-medium text-gray-600 hover:text-indigo-700 transition-colors"
          >
            ← All subjects
          </Link>
        )}
      </div>
    </header>
  );
};

export default Header;
