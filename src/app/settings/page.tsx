import { PageHeader } from "@/components/page-header";
import { SettingsToggle } from "@/components/settings-toggle";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getHideCash, getHideZeroAccounts } from "@/lib/config";
import { getSidebarVisibleTabs } from "@/lib/config";
import { SidebarTabPreferences } from "@/components/sidebar-tab-preferences";

import { SettingsDataControls } from "@/components/settings-data-controls";
import { listSpreadsheets, spreadsheetSummary } from "@/lib/spreadsheets";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [hideCash, hideZero, visibleTabs, uploads] = await Promise.all([getHideCash(), getHideZeroAccounts(), getSidebarVisibleTabs(), listSpreadsheets()]);

  return (
    <>
      <PageHeader title="Settings" description="Preferences for how your dashboard looks and totals up." />

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="text-base">Display</CardTitle>
        </CardHeader>
        <CardContent className="divide-y py-0">
          <SettingsToggle
            field="hideZeroAccounts"
            checked={hideZero}
            label="Hide $0 accounts"
            description="Keep empty accounts out of lists, dropdowns, and the accounts page."
          />
          <SettingsToggle
            field="hideCash"
            checked={hideCash}
            label="Hide cash from net worth"
            description="Exclude your manual Cash account from net-worth totals by default. The live account picker can still override this per view."
          />
        </CardContent>
      </Card>
      <Card className="mt-6 max-w-2xl">
        <CardHeader>
          <CardTitle className="text-base">Sidebar</CardTitle>
          <p className="text-muted-foreground text-sm">Choose the places you use most. Settings always stays available, and the desktop sidebar can be collapsed.</p>
        </CardHeader>
        <CardContent className="pt-0">
          <SidebarTabPreferences initialVisibleTabs={visibleTabs} />
        </CardContent>
      </Card>
      <div className="mt-6"><SettingsDataControls initialUploads={uploads.map(spreadsheetSummary)} /></div>
    </>
  );
}
