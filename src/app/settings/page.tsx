import { PageHeader, Section } from "@/components/kit";
import { SettingsToggle } from "@/components/settings-toggle";
import { getHideCash, getHideZeroAccounts, getSidebarVisibleTabs } from "@/lib/config";
import { SidebarTabPreferences } from "@/components/sidebar-tab-preferences";
import { SettingsDataControls } from "@/components/settings-data-controls";
import { listSpreadsheets, spreadsheetSummary } from "@/lib/spreadsheets";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [hideCash, hideZero, visibleTabs, uploads] = await Promise.all([getHideCash(), getHideZeroAccounts(), getSidebarVisibleTabs(), listSpreadsheets()]);

  return (
    <>
      <PageHeader title="Settings" description="Preferences for how your dashboard looks and totals up." />

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-2 lg:gap-8">
        <Section title="Display" surface>
          <div className="divide-y px-4 md:px-5">
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
          </div>
        </Section>

        <Section title="Sidebar" description="Choose the sections you use most. Hidden sections stay one search away (⌘K), and the desktop sidebar can be collapsed." surface bodyClassName="p-4 md:p-5 max-sm:[&>div]:grid-cols-1">
          <SidebarTabPreferences initialVisibleTabs={visibleTabs} />
        </Section>
      </div>

      <div className="mt-4 [&>div]:mt-6 [&>div]:max-w-none">
        <SettingsDataControls initialUploads={uploads.map(spreadsheetSummary)} />
      </div>
    </>
  );
}
