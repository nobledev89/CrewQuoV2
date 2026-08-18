'use client';
import { Shell } from '@/components/Shell';
import { AdminGate } from '@/components/admin/AdminGate';
import { UsersConsole } from '@/components/admin/UsersConsole';
export default function AdminUsersPage() { return <Shell><AdminGate title="Users"><UsersConsole /></AdminGate></Shell>; }

