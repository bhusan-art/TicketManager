import { Route, Routes } from 'react-router';
import { RequireAuth, RequireRole } from './auth/guards';
import { Layout } from './components/Layout';
import { Categories } from './pages/admin/Categories';
import { EmailLog } from './pages/admin/EmailLog';
import { Settings } from './pages/admin/Settings';
import { Notifications } from './pages/notifications/Notifications';
import { AdvanceDetails } from './pages/advances/AdvanceDetails';
import { AdvanceForm } from './pages/advances/AdvanceForm';
import { AdvanceList } from './pages/advances/AdvanceList';
import { Departments } from './pages/admin/Departments';
import { UserForm } from './pages/admin/UserForm';
import { Users } from './pages/admin/Users';
import { ApprovalQueue } from './pages/approvals/ApprovalQueue';
import { Dashboard } from './pages/Dashboard';
import { PaymentQueue } from './pages/payments/PaymentQueue';
import { Reports } from './pages/reports/Reports';
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
          <Route path="advances" element={<AdvanceList />} />
          <Route path="advances/new" element={<AdvanceForm key="new" />} />
          <Route path="advances/:id" element={<AdvanceDetails />} />
          <Route path="advances/:id/edit" element={<AdvanceForm key="edit" />} />
          <Route path="settlements" element={<AdvanceList settlements />} />
          <Route
            path="approvals"
            element={
              <RequireRole roles={['manager', 'director']}>
                <ApprovalQueue base="/approvals" />
              </RequireRole>
            }
          />
          <Route path="approvals/:id" element={<VoucherDetails />} />
          <Route
            path="verification"
            element={
              <RequireRole roles={['accounts']}>
                <ApprovalQueue base="/verification" />
              </RequireRole>
            }
          />
          <Route path="verification/:id" element={<VoucherDetails />} />
          <Route
            path="payments"
            element={
              <RequireRole roles={['accounts']}>
                <PaymentQueue />
              </RequireRole>
            }
          />
          <Route path="payments/:id" element={<VoucherDetails />} />
          <Route
            path="reports"
            element={
              <RequireRole roles={['accounts', 'director', 'admin']}>
                <Reports />
              </RequireRole>
            }
          />
          <Route path="notifications" element={<Notifications />} />
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
          <Route
            path="admin/emails"
            element={
              <RequireRole roles={['admin']}>
                <EmailLog />
              </RequireRole>
            }
          />
          <Route
            path="admin/settings"
            element={
              <RequireRole roles={['admin']}>
                <Settings />
              </RequireRole>
            }
          />
          <Route path="*" element={<Placeholder title="Page not found" />} />
        </Route>
      </Route>
    </Routes>
  );
}
