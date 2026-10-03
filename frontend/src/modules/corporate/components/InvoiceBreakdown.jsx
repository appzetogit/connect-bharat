import { Table, formatDate, formatMoney } from './ui';
import { formatKm } from './helpers';

/**
 * Invoice detail body: department lines, the corporate v2 role summary and the
 * per-trip annex with allowance / split columns. Shared by the corporate panel
 * and the admin corporate detail page. `invoice` is the GET .../invoices/:id
 * payload.
 */

const num = (value) => Number(value || 0);
const roleSummaryOf = (invoice) => invoice?.byRole || invoice?.summary?.byRole || [];

export default function InvoiceBreakdown({ invoice }) {
  const annex = invoice?.annex || [];
  const byRole = roleSummaryOf(invoice);
  const departments = invoice?.lines || [];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <div><p className="text-xs text-gray-500">Period</p><p className="font-medium">{invoice.periodKey}</p></div>
        <div><p className="text-xs text-gray-500">Trips</p><p className="font-medium tabular-nums">{invoice.tripCount}</p></div>
        <div><p className="text-xs text-gray-500">Total</p><p className="font-medium tabular-nums">{formatMoney(invoice.total)}</p></div>
        <div><p className="text-xs text-gray-500">Balance due</p><p className="font-medium tabular-nums">{formatMoney(invoice.balanceDue)}</p></div>
      </div>

      {byRole.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-gray-900 mb-2">By role</h3>
          <Table
            rowKey={(row) => row.roleId || row.roleName}
            columns={[
              { key: 'roleName', label: 'Role', render: (row) => row.roleName || 'No role' },
              { key: 'trips', label: 'Trips', align: 'right' },
              { key: 'km', label: 'Km', align: 'right', render: (row) => formatKm(row.km ?? row.actualKm) },
              { key: 'coveredKm', label: 'Covered', align: 'right', render: (row) => formatKm(row.coveredKm) },
              { key: 'excessKm', label: 'Excess', align: 'right', render: (row) => formatKm(row.excessKm) },
              { key: 'billed', label: 'Billed', align: 'right', render: (row) => formatMoney(row.billedAmount ?? row.billed) },
            ]}
            rows={byRole}
          />
        </section>
      )}

      {departments.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-gray-900 mb-2">By department</h3>
          <Table
            rowKey={(row) => row.departmentId || row.departmentName}
            columns={[
              { key: 'departmentName', label: 'Department', render: (row) => <div><p>{row.departmentName}</p>{row.costCenter && <p className="text-xs text-gray-500">{row.costCenter}</p>}</div> },
              { key: 'trips', label: 'Trips', align: 'right' },
              { key: 'grossAmount', label: 'Gross', align: 'right', render: (row) => formatMoney(row.grossAmount) },
              { key: 'discountAmount', label: 'Discount', align: 'right', render: (row) => formatMoney(row.discountAmount) },
              { key: 'netAmount', label: 'Net', align: 'right', render: (row) => formatMoney(row.netAmount) },
            ]}
            rows={departments}
          />
        </section>
      )}

      <section>
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Trips ({annex.length})</h3>
        {!annex.length ? <p className="text-sm text-gray-500">No trips on this invoice.</p> : (
          <Table
            rowKey={(row) => row.refId}
            columns={[
              { key: 'date', label: 'Date', render: (row) => <span className="whitespace-nowrap">{formatDate(row.completedAt || row.date, true)}</span> },
              { key: 'employee', label: 'Employee', render: (row) => <div><p className="font-medium whitespace-nowrap">{row.employeeName || '-'}</p><p className="text-xs text-gray-500 font-mono">{row.employeeCode}</p></div> },
              { key: 'roleName', label: 'Role', render: (row) => row.roleName || '-' },
              {
                key: 'route',
                label: 'Route',
                render: (row) => (
                  <div className="text-xs max-w-[14rem]">
                    <p>{row.pickupAddress || row.pickup}</p>
                    <p className="text-gray-500">→ {row.dropAddress || row.drop}</p>
                    <p className="text-gray-400">{[row.vehicleName, row.serviceType === 'intercity' ? 'outstation' : row.serviceType, row.pricing === 'company_tariff' ? 'company tariff' : ''].filter(Boolean).join(' · ')}</p>
                  </div>
                ),
              },
              { key: 'actualKm', label: 'Km', align: 'right', render: (row) => formatKm(row.actualKm) },
              { key: 'coveredKm', label: 'Covered', align: 'right', render: (row) => formatKm(row.coveredKm) },
              { key: 'excessKm', label: 'Excess', align: 'right', render: (row) => (num(row.excessKm) > 0 ? <span className="text-red-700">{formatKm(row.excessKm)}</span> : formatKm(0)) },
              { key: 'grossFare', label: 'Fare', align: 'right', render: (row) => formatMoney(row.grossFare ?? row.grossAmount) },
              { key: 'employeeAmount', label: 'Employee share', align: 'right', render: (row) => formatMoney(row.employeeAmount) },
              { key: 'companyAmount', label: 'Company share', align: 'right', render: (row) => formatMoney(row.companyAmount ?? row.grossAmount) },
              { key: 'billedAmount', label: 'Billed', align: 'right', render: (row) => <span className="font-medium">{formatMoney(row.billedAmount ?? row.netAmount)}</span> },
            ]}
            rows={annex}
          />
        )}
      </section>
    </div>
  );
}
