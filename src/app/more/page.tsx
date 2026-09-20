/**
 * More Page (/more)
 *
 * Issue #600: UX refresh - Settings, External Apps, Help, Auth.
 * On mobile, Repositories is accessible from here.
 *
 * Issue #2645: 見出しは `common.nav.more`、説明文は `common.settings.pageDescription`。
 *
 * Issue #2707: 中身は `SettingsPanel` に移した。このページが持つのは
 * `<h1>` と説明文とページの余白だけで、同じ中身を PC の設定モーダル（#2708）も描く。
 */

'use client';

import { useTranslations } from 'next-intl';
import { SettingsPanel } from '@/components/settings';

export default function MorePage() {
  const tCommon = useTranslations('common');

  return (
    <div className="container-custom py-8 overflow-auto h-full">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground mb-2">{tCommon('nav.more')}</h1>
        <p className="text-sm text-muted-foreground">
          {tCommon('settings.pageDescription')}
        </p>
      </div>

      <SettingsPanel />
    </div>
  );
}
