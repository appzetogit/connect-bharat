import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { corporateApi, errorMessage } from '../services/corporateApi';
import { Badge, Button, Empty, ErrorNote, Loading, PageHeader, Pager, Select, Table, formatDate, formatMoney, useLoad } from '../components/ui';

/**
 * Trips waiting for a decision. The rider is already on the "finding a driver"
 * screen while this is pending, so the list refreshes itself every 20 seconds.
 */
export default function CorporateApprovals() {
  const [status, setStatus] = useState('pending');
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState('');
  const { data, loading, error, reload } = useLoad(() => corporateApi.tripRequests({ status, page, limit: 25 }), [status, page]);

  useEffect(() => {
    if (status !== 'pending') return undefined;
    const timer = setInterval(reload, 20000);
    return () => clearInterval(timer);
  }, [status, reload]);

  const decide = async (row, approve) => {
    const note = approve ? '' : window.prompt('Reason for rejecting (shown to the employee)', '') ?? null;
    if (note === null) return;
    setBusyId(row._id);
    try {
      if (approve) await corporateApi.approveTrip(row._id);
      else await corporateApi.rejectTrip(row._id, note);
      toast.success(approve ? 'Approved, finding a driver' : 'Rejected');
      reload();
    } catch (err) {
      toast.error(errorMessage(err));
      reload();
    } finally {
      setBusyId('');
    }
  };

  return (
    <>
      <PageHeader
        title="Trip approvals"
        subtitle="Trips outside policy wait here. Unanswered requests expire and the trip is cancelled."
        actions={(
          <div className="w-44">
            <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="pending">Pending</option>
              <option value="booked">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="expired">Expired</option>
              <option value="cancelled">Cancelled</option>
              <option value="">All</option>
            </Select>
          </div>
        )}
      />
      <ErrorNote message={error} />
      {loading && !data ? <Loading /> : !data?.items?.length ? <Empty title={status === 'pending' ? 'Nothing waiting for approval.' : 'No requests.'} /> : (
        <>
          <Table
            columns={[
              { key: 'createdAt', label: 'Requested', render: (row) => formatDate(row.createdAt, true) },
              { key: 'employee', label: 'Employee', render: (row) => <div><p className="font-medium">{row.employeeId?.name || '-'}</p><p className="text-xs text-gray-500">{row.departmentId?.name || 'Unassigned'}</p></div> },
              { key: 'route', label: 'Trip', render: (row) => <div className="max-w-xs"><p className="text-xs"><span className="text-gray-400">From</span> {row.pickupAddress || '-'}</p><p className="text-xs"><span className="text-gray-400">To</span> {row.dropAddress || '-'}</p><p className="text-xs text-gray-500 mt-1">{row.serviceType === 'intercity' ? 'outstation' : row.serviceType}{row.scheduledAt ? ` · for ${formatDate(row.scheduledAt, true)}` : ''}</p></div> },
              { key: 'reasons', label: 'Why', render: (row) => <ul className="text-xs text-gray-600 list-disc pl-4">{(row.reasons || []).map((reason) => <li key={reason}>{reason}</li>)}</ul> },
              { key: 'billableAmount', label: 'Amount', align: 'right', render: (row) => formatMoney(row.billableAmount) },
              {
                key: 'status',
                label: 'Status',
                render: (row) => (
                  <div>
                    <Badge value={row.status} />
                    {row.status === 'pending' && row.expiresAt && <p className="text-xs text-gray-400 mt-1">expires {formatDate(row.expiresAt, true)}</p>}
                    {row.approverId?.name && <p className="text-xs text-gray-400 mt-1">by {row.approverId.name}</p>}
                    {row.note && <p className="text-xs text-gray-500 mt-1">{row.note}</p>}
                  </div>
                ),
              },
              {
                key: 'actions',
                label: '',
                render: (row) => row.status === 'pending' && (
                  <div className="flex gap-2 justify-end">
                    <Button variant="success" busy={busyId === row._id} onClick={() => decide(row, true)}>Approve</Button>
                    <Button variant="danger" disabled={busyId === row._id} onClick={() => decide(row, false)}>Reject</Button>
                  </div>
                ),
              },
            ]}
            rows={data.items}
          />
          <Pager page={data.page} total={data.total} limit={data.limit} onPage={setPage} />
        </>
      )}
    </>
  );
}
