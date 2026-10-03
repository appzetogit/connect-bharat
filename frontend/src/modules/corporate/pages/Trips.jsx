import { useState } from 'react';
import toast from 'react-hot-toast';
import { Download } from 'lucide-react';
import { corporateApi, downloadFile, errorMessage } from '../services/corporateApi';
import { Badge, Button, Empty, ErrorNote, Input, Loading, PageHeader, Pager, Select, Table, currentMonth, formatDate, formatMoney, monthRange, useLoad } from '../components/ui';

export default function CorporateTrips() {
  const [month, setMonth] = useState(currentMonth());
  const [status, setStatus] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [page, setPage] = useState(1);
  const range = monthRange(month);
  const { data, loading, error } = useLoad(
    () => corporateApi.trips({ ...range, status: status || undefined, departmentId: departmentId || undefined, page, limit: 25 }),
    [month, status, departmentId, page],
  );
  const { data: departments } = useLoad(() => corporateApi.departments(), []);

  const exportCsv = () =>
    downloadFile('/corporate/trips', `corporate-trips-${month}.csv`, { ...range, status: status || undefined, departmentId: departmentId || undefined, format: 'csv' })
      .catch((err) => toast.error(errorMessage(err)));

  return (
    <>
      <PageHeader title="Trips" subtitle="Every trip billed to the company." actions={<Button variant="secondary" onClick={exportCsv}><Download size={14} /> Export CSV</Button>} />
      <div className="flex flex-wrap gap-2 mb-4">
        <div className="w-44"><Input type="month" value={month} onChange={(e) => { setMonth(e.target.value); setPage(1); }} /></div>
        <div className="w-44">
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">Any status</option>
            <option value="completed">Completed</option>
            <option value="searching">Searching / awaiting approval</option>
            <option value="ongoing">Ongoing</option>
            <option value="cancelled">Cancelled</option>
          </Select>
        </div>
        <div className="w-52">
          <Select value={departmentId} onChange={(e) => { setDepartmentId(e.target.value); setPage(1); }}>
            <option value="">All departments</option>
            {(departments || []).map((department) => <option key={department._id} value={department._id}>{department.name}</option>)}
          </Select>
        </div>
      </div>
      <ErrorNote message={error} />
      {loading ? <Loading /> : !data?.items?.length ? <Empty title="No trips in this period." /> : (
        <>
          <Table
            rowKey={(row) => row.rideId}
            columns={[
              { key: 'createdAt', label: 'Date', render: (row) => formatDate(row.completedAt || row.createdAt, true) },
              { key: 'employee', label: 'Employee', render: (row) => <div><p className="font-medium">{row.employee?.name || '-'}</p><p className="text-xs text-gray-500">{row.department?.name || 'Unassigned'}</p></div> },
              { key: 'route', label: 'Route', render: (row) => <div className="max-w-sm text-xs"><p>{row.pickupAddress}</p><p className="text-gray-500">→ {row.dropAddress}</p></div> },
              { key: 'serviceType', label: 'Service', render: (row) => (row.serviceType === 'intercity' ? 'outstation' : row.serviceType) },
              { key: 'status', label: 'Status', render: (row) => <div><Badge value={row.status} />{row.approvalStatus !== 'not_required' && <p className="text-xs text-gray-400 mt-1">approval: {row.approvalStatus}</p>}</div> },
              { key: 'grossFare', label: 'Fare', align: 'right', render: (row) => formatMoney(row.grossFare) },
              { key: 'billedAmount', label: 'Billed', align: 'right', render: (row) => formatMoney(row.billedAmount) },
            ]}
            rows={data.items}
          />
          <Pager page={data.page} total={data.total} limit={data.limit} onPage={setPage} />
        </>
      )}
    </>
  );
}
