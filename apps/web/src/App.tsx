import { Route, Routes } from 'react-router';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { Placeholder } from './pages/Placeholder';

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="expenses" element={<Placeholder title="Expenses" phase={2} />} />
        <Route path="approvals" element={<Placeholder title="Approvals" phase={3} />} />
        <Route path="advances" element={<Placeholder title="Advances" phase={5} />} />
        <Route path="settlements" element={<Placeholder title="Settlements" phase={5} />} />
        <Route path="reports" element={<Placeholder title="Reports" phase={4} />} />
        <Route path="notifications" element={<Placeholder title="Notifications" phase={6} />} />
        <Route path="profile" element={<Placeholder title="Profile" phase={1} />} />
        <Route path="*" element={<Placeholder title="Page not found" />} />
      </Route>
    </Routes>
  );
}
