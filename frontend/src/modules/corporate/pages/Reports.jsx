import { useState } from 'react';
import toast from 'react-hot-toast';
import { Download } from 'lucide-react';
import { corporateApi, downloadFile, errorMessage } from '../services/corporateApi';
import { Button, Card, ErrorNote, Input, Loading, PageHeader, StatCard, Table, currentMonth, formatMoney, monthRange, useLoad } from '../components/ui';

const TABS = [
  { key: 'usage', label: 'Usage' },
  { key: 'departments', label: 'Departments' },
  { key: 'employees', label: 'Employees' },
];

export default function CorporateReports() {
  const [tab, setTab] = useState('usage');
  const [month, setMonth] = useState(currentMonth());
  const range = monthRange(month);
  const usage = useLoad(() => (tab === 'usage' ? corporateApi.usage(range) : Promise.resolve(null)), [tab, month]);
  const departments = useLoad(() => (tab === 'departments' ? corporateApi.departmentReport(range) : Promise.resolve(null)), [tab, month]);
  const employees = useLoad(() => (tab === 'employees' ? corporateApi.employeeReport(range) : Promise.resolve(null)), [tab, month]);

  const exportCsv = () => {
    const path = tab === 'departments' ? '/corporate/reports/departments' : tab === 'employees' ? '/corporate/reports/employees' : '/corporate/trips';
    downloadFile(path, `${tab}-report-${month}.csv`, { ...range, format: 'csv' }).catch((err) => toast.error(errorMessage(err)));
  };

  const active = tab === 'usage' ? usage : tab === 'departments' ? departments : employees;

  return (
    <>
      <PageHeader
        title="Reports"
        actions={(
          <>
            <div className="w-44"><Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></div>
            <Button variant="secondary" onClick={exportCsv}><Download size={14} /> CSV</Button>
          </>
        )}
      />
      <div className="flex gap-2 mb-4">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            className={`text-sm rounded-lg px-3 py-1.5 border ${tab === item.key ? 'bg-gray-900 border-gray-900 text-white' : 'bg-white border-gray-200 text-gray-600'}`}
          >
            {item.label}
          </button>
        ))}
      </div>
      <ErrorNote message={active.error} />
      {active.loading || !active.data ? <Loading /> : tab === 'usage' ? (
        <div className="space-y-5">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard label="Trips" value={usage.data.totals.trips} />
            <StatCard label="Spend" value={formatMoney(usage.data.totals.totalSpend)} />
            <StatCard label="Average fare" value={formatMoney(usage.data.totals.avgFare)} />
            <StatCard label="Distance" value={`${usage.data.totals.distanceKm} km`} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <h2 className="font-semibold mb-2">By service</h2>
              <Table rowKey={(row) => row.serviceType} columns={[
                { key: 'serviceType', label: 'Service', render: (row) => (row.serviceType === 'intercity' ? 'outstation' : row.serviceType) },
                { key: 'trips', label: 'Trips', align: 'right' },
                { key: 'spend', label: 'Spend', align: 'right', render: (row) => formatMoney(row.spend) },
                { key: 'avgFare', label: 'Avg', align: 'right', render: (row) => formatMoney(row.avgFare) },
              ]} rows={usage.data.byService} />
            </div>
            <div>
              <h2 className="font-semibold mb-2">Daily trend</h2>
              <Card className="p-4">
                <div className="flex items-end gap-1 h-32">
                  {usage.data.byDay.map((row) => {
                    const max = Math.max(...usage.data.byDay.map((item) => item.spend), 1);
                    return <div key={row.day} title={`${row.day}: ${formatMoney(row.spend)} (${row.trips} trips)`} className="flex-1 bg-gray-900 rounded-t" style={{ height: `${Math.max(3, (row.spend / max) * 100)}%` }} />;
                  })}
                </div>
                {!usage.data.byDay.length && <p className="text-sm text-gray-400">No trips.</p>}
              </Card>
            </div>
          </div>
          <div>
            <h2 className="font-semibold mb-2">Top routes</h2>
            <Table rowKey={(row) => `${row.pickup}|${row.drop}`} columns={[
              { key: 'pickup', label: 'From', render: (row) => <span className="text-xs">{row.pickup}</span> },
              { key: 'drop', label: 'To', render: (row) => <span className="text-xs">{row.drop}</span> },
              { key: 'trips', label: 'Trips', align: 'right' },
              { key: 'spend', label: 'Spend', align: 'right', render: (row) => formatMoney(row.spend) },
            ]} rows={usage.data.topRoutes} />
          </div>
        </div>
      ) : tab === 'departments' ? (
        <Table rowKey={(row) => row.departmentId || 'none'} columns={[
          { key: 'name', label: 'Department' },
          { key: 'costCenter', label: 'Cost centre' },
          { key: 'travellingEmployees', label: 'Travellers', align: 'right' },
          { key: 'trips', label: 'Trips', align: 'right' },
          { key: 'spend', label: 'Spend', align: 'right', render: (row) => formatMoney(row.spend) },
          { key: 'avgFare', label: 'Avg fare', align: 'right', render: (row) => formatMoney(row.avgFare) },
          { key: 'budget', label: 'Budget used', align: 'right', render: (row) => (row.budgetUsedPercent === null ? '-' : `${row.budgetUsedPercent}% of ${formatMoney(row.monthlyBudget)}`) },
        ]} rows={departments.data.departments} />
      ) : (
        <Table rowKey={(row) => row.employeeId} columns={[
          { key: 'name', label: 'Employee', render: (row) => `${row.name}${row.employeeCode ? ` (${row.employeeCode})` : ''}` },
          { key: 'department', label: 'Department' },
          { key: 'trips', label: 'Trips', align: 'right' },
          { key: 'spend', label: 'Spend', align: 'right', render: (row) => formatMoney(row.spend) },
          { key: 'avgFare', label: 'Avg fare', align: 'right', render: (row) => formatMoney(row.avgFare) },
          { key: 'monthlyLimit', label: 'Limit', align: 'right', render: (row) => (row.monthlyLimit ? formatMoney(row.monthlyLimit) : '-') },
        ]} rows={employees.data.employees} />
      )}
    </>
  );
}
