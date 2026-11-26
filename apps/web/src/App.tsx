import { Route, Routes } from 'react-router';
import { RequireAuth, RequireRole } from './auth/guards';
import { Layout } from './components/Layout';
import { Categories } from './pages/admin/Categories';
import { Departments } from './pages/admin/Departments';
import { UserForm } from './pages/admin/UserForm';
import { Users } from './pages/admin/Users';
import { Dashboard } from './pages/Dashboard';
import { MyExpenses } from './pages/expenses/MyExpenses';
import { VoucherDetails } from './pages/expenses/VoucherDetails';
import { VoucherForm } from './pages/expenses/VoucherForm';
import { ForgotPassword } from './pages/ForgotPassword';
import { Login } from './pages/Login';
import { Placeholder } from './pages/Placeholder';
import { Profile } from './pages/Profile';
import { ResetPassword } from './pages/ResetPassword';

export function App() {
  return (
    <Routes>
      <Route path="login" element={<Login />} />
      <Route path="forgot-password" element={<ForgotPassword />} />
      <Route path="reset-password" element={<ResetPassword />} />
      <Route path="set-password" element={<ResetPassword invite />} />

      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="expenses" element={<MyExpenses />} />
          <Route path="expenses/new" element={<VoucherForm key="new" />} />
          <Route path="expenses/:id" element={<VoucherDetails />} />
          <Route path="expenses/:id/edit" element={<VoucherForm key="edit" />} />
          <Route path="advances" element={<Placeholder title="Advances" phase={5} />} />
          <Route path="settlements" element={<Placeholder title="Settlements" phase={5} />} />
          <Route path="approvals" element={<Placeholder title="Approvals" phase={3} />} />
          <Route path="verification" element={<Placeholder title="Verification" phase={3} />} />
          <Route path="payments" element={<Placeholder title="Payments" phase={4} />} />
          <Route path="reports" element={<Placeholder title="Reports" phase={4} />} />
          <Route path="notifications" element={<Placeholder title="Notifications" phase={6} />} />
          <Route path="profile" element={<Profile />} />
          <Route
            path="admin/users"
            element={
              <RequireRole roles={['admin']}>
                <Users />
              </RequireRole>
            }
          />
          <Route
            path="admin/users/new"
            element={
              <RequireRole roles={['admin']}>
                <UserForm />
              </RequireRole>
            }
          />
          <Route
            path="admin/users/:id"
            element={
              <RequireRole roles={['admin']}>
                <UserForm />
              </RequireRole>
            }
          />
          <Route
            path="admin/departments"
            element={
              <RequireRole roles={['admin']}>
                <Departments />
              </RequireRole>
            }
          />
          <Route
            path="admin/categories"
            element={
              <RequireRole roles={['admin']}>
                <Categories />
              </RequireRole>
            }
          />
          <Route path="*" element={<Placeholder title="Page not found" />} />
        </Route>
      </Route>
    </Routes>
  );
}
