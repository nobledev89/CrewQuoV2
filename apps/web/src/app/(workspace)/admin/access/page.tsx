'use client';
import { Shell } from '@/components/Shell';
import { AdminGate } from '@/components/admin/AdminGate';
import { UsersConsole } from '@/components/admin/UsersConsole';
export default function AdminAccessPage() { return <Shell><AdminGate title="Admin access"><UsersConsole accessOnly /></AdminGate></Shell>; }

