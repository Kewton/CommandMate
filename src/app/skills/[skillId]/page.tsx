/**
 * Skill Detail Page (/skills/[skillId])
 *
 * Issue #1232: one Catalog entry, presented as an installable capability.
 */

'use client';

import { useParams } from 'next/navigation';
import { SkillDetailView } from '@/components/skills/SkillDetailView';

export default function SkillDetailPage() {
  const params = useParams();
  const skillId = typeof params.skillId === 'string' ? params.skillId : '';

  return (
    <div className="container-custom py-8 overflow-auto h-full">
      <SkillDetailView skillId={skillId} />
    </div>
  );
}
