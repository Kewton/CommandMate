'use client';

/**
 * QrCodeGenerator - QR Code generation for mobile access
 * Issue #383: QR code login for mobile access via ngrok
 *
 * Security features:
 * - S001: QR code hidden by default (shoulder surfing protection)
 * - Token input uses type="password"
 * - HTTPS warning for non-secure URLs
 * - Token is never sent to the server (client-side only QR generation)
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import QRCode from 'react-qr-code';

export function QrCodeGenerator() {
  const t = useTranslations('auth');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [qrVisible, setQrVisible] = useState(false); // S001: default hidden

  const qrValue = url && token ? `${url}/login#token=${token}` : '';
  const isHttp = url.startsWith('http://') && !url.startsWith('https://');

  return (
    <div className="mt-6 p-4 border border-gray-200 dark:border-gray-700 rounded-lg">
      <h2 className="text-lg font-semibold mb-4 text-gray-900 dark:text-white">
        {t('login.qr.sectionTitle')}
      </h2>

      <div className="space-y-3">
        <div>
          <input
            type="text"
            placeholder={t('login.qr.urlPlaceholder')}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-label={t('login.qr.urlLabel')}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-white text-sm"
          />
          {isHttp && (
            <p className="mt-1 text-sm text-yellow-600 dark:text-yellow-400">
              {t('login.qr.httpsWarning')}
            </p>
          )}
        </div>

        <div>
          <input
            type="password"
            placeholder={t('login.qr.tokenPlaceholder')}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            aria-label={t('login.qr.tokenLabel')}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-white text-sm"
            autoComplete="off"
          />
        </div>

        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t('login.qr.securityNotice')}
        </p>

        {qrValue && (
          <button
            type="button"
            onClick={() => setQrVisible(!qrVisible)}
            className="w-full py-2 px-4 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
          >
            {qrVisible ? t('login.qr.hideQrButton') : t('login.qr.showQrButton')}
          </button>
        )}

        {qrVisible && qrValue && (
          <div className="space-y-3">
            <p className="text-sm text-amber-600 dark:text-amber-400">
              {t('login.qr.qrSecurityWarning')}
            </p>
            <div className="flex justify-center p-4 bg-white rounded-lg">
              <QRCode value={qrValue} size={200} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
