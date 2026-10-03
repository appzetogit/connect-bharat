import { useState } from 'react';
import { Link } from 'react-router-dom';
import { corporateApi } from '../services/corporateApi';
import { CORPORATE_BASE_PATH } from '../services/corporateApi';
import { Card, ErrorNote, Input, Loading, PageHeader, StatCard, Table, currentMonth, formatMoney, monthRange, useLoad } from '../components/ui';

const Bar = ({ label, value, max }) => (
  <div>
    <div className="flex justify-between text-xs text-gray-600 mb-1">
      <span className="truncate pr-2">{label}</span>
      <span className="tabular-nums">{formatMoney(value)}</span>
    </div>
    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
      <div className="h-full bg-gray-900 rounded-full" style={{ width: `${max ? Math.max(2, (value / max) * 100) : 0}%` }} />
    </div>
  </div>
);

export default function CorporateDashboard() {
  const [month, setMonth] = useState(currentMonth());
  const { data, loading, error } = useLoad(() => corporateApi.dashboard(monthRange(month)), [month]);

  const maxDepartment = Math.max(0, ...(data?.byDepartment || []).map((row) => row.spend));
  const maxService = Math.max(0, ...(data?.byService || []).map((row) => row.spend));

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Spend, trips and what you owe."
        actions={<Input type="month" value={month} onChange={(event) => setMonth(event.target.value)} />}
      />
      <ErrorNote message={error} />
      {loading || !data ? (
        <Loading />
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard label="Spend this period" value={formatMoney(data.totals.totalSpend)} hint={`${formatMoney(data.totals.discount)} saved by your discount`} />
            <StatCard label="Trips" value={data.totals.trips + (data.totals.rentalTrips || 0)} hint={`Avg ${formatMoney(data.totals.avgFare)} per trip`} />
            <StatCard label="Outstanding" value={formatMoney(data.outstanding)} hint={`Credit limit ${formatMoney(data.creditLimit)}`} />
            <StatCard
              label="Pending approvals"
              value={data.pendingApprovals}
              hint={data.pendingApprovals ? <Link className="underline" to={`${CORPORATE_BASE_PATH}/approvals`}>Review now</Link> : 'Nothing waiting'}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card className="p-5 space-y-3">
              <h2 className="font-semibold text-gray-900">Spend by department</h2>
              {data.byDepartment.length ? data.byDepartment.map((row) => <Bar key={row.departmentId || 'none'} label={row.name} value={row.spend} max={maxDepartment} />) : <p className="text-sm text-gray-400">No trips yet.</p>}
            </Card>
            <Card className="p-5 space-y-3">
              <h2 className="font-semibold text-gray-900">Spend by service</h2>
              {data.byService.length ? data.byService.map((row) => <Bar key={row.serviceType} label={row.serviceType === 'intercity' ? 'outstation' : row.serviceType} value={row.spend} max={maxService} />) : <p className="text-sm text-gray-400">No trips yet.</p>}
            </Card>
          </div>

          {data.aging && (
            <Card className="p-5">
              <h2 className="font-semibold text-gray-900 mb-3">Invoice aging</h2>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
                {[['current', 'Not yet due'], ['1_30', '1-30 days'], ['31_60', '31-60 days'], ['61_90', '61-90 days'], ['90_plus', '90+ days']].map(([key, label]) => (
                  <div key={key}>
                    <p className="text-xs text-gray-500">{label}</p>
                    <p className="font-semibold tabular-nums">{formatMoney(data.aging.buckets[key]?.amount)}</p>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <div>
            <h2 className="font-semibold text-gray-900 mb-2">Top travellers</h2>
            <Table
              rowKey={(row) => row.employeeId}
              columns={[
                { key: 'name', label: 'Employee', render: (row) => `${row.name}${row.employeeCode ? ` (${row.employeeCode})` : ''}` },
                { key: 'trips', label: 'Trips', align: 'right' },
                { key: 'spend', label: 'Spend', align: 'right', render: (row) => formatMoney(row.spend) },
              ]}
              rows={data.byEmployee.slice(0, 8)}
            />
          </div>
        </div>
      )}
    </>
  );
}
