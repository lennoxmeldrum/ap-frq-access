import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import Header from './components/Header';
import SubjectPicker from './components/SubjectPicker';
import SubjectArchive from './components/SubjectArchive';

const App: React.FC = () => {
  return (
    <div className="min-h-screen flex flex-col bg-gray-50 text-gray-900">
      <Header />
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<SubjectPicker />} />
          <Route path="/subject/:subject" element={<SubjectArchive />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <footer className="py-6 text-center text-xs text-gray-500">
        AP FRQ Archive · Read-only view of the AP Infinite FRQ Generator archive
      </footer>
    </div>
  );
};

export default App;
