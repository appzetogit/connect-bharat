import { useState } from 'react';
import toast from 'react-hot-toast';
import { Download, ExternalLink, RefreshCw } from 'lucide-react';
import { corporateApi, downloadFile, errorMessage } from '../services/corporateApi';
import { Badge, Button, Card, Empty, ErrorNote, Loading, PageHeader, Pager, StatCard, Table, formatDate, formatMoney, useLoad } from '../components/ui';

export default function CorporateInvoices() {
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState('');
  const { data, loading, error, reload } = useLoad(() => corporateApi.invoices({ page, limit: 25 }), [page]);
  const { data: outstanding } = useLoad(() => corporateApi.outstanding({ limit: 10 }), []);

  const pay = async (invoice) => {
    setBusyId(invoice._id);
    try {
      const link = await corporateApi.payInvoice(invoice._id);
      if (link?.url) window.open(link.url, '_blank', 'noopener');
    } catch (err) {
      toast.error(errorMessage(err, 'Online payment is not available. Please pay by bank transfer.'));
    } finally {
      setBusyId('');
    }
  };

  const sync = async (invoice) => {
    setBusyId(invoice._id);
    try {
      await corporateApi.syncInvoicePayment(invoice._id);
      toast.success('Payment status refreshed');
      reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusyId('');
    }
  };

  const buckets = outstanding?.aging?.buckets || {};

  return (
    <>
      <PageHeader title="Invoices" subtitle="Consolidated monthly invoices with a per-trip annexure." />
      {outstanding && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
          <StatCard label="Account outstanding" value={formatMoney(outstanding.currentOutstanding)} hint="All completed trips not yet paid" />
          <StatCard label="Invoiced and due" value={formatMoney(outstanding.aging?.totalDue)} />
          <StatCard label="Overdue" value={formatMoney((buckets['1_30']?.amount || 0) + (buckets['31_60']?.amount || 0) + (buckets['61_90']?.amount || 0) + (buckets['90_plus']?.amount || 0))} />
          <StatCard label="Credit limit" value={formatMoney(outstanding.creditLimit)} />
        </div>
      )}
      <ErrorNote message={error} />
      {loading ? <Loading /> : !data?.items?.length ? <Empty title="No invoices yet." hint="Invoices are raised monthly for the previous month's trips." /> : (
        <>
          <Table
            columns={[
              { key: 'invoiceNumber', label: 'Invoice', render: (row) => <div><p className="font-medium">{row.invoiceNumber}</p><p className="text-xs text-gray-500">{formatDate(row.periodFrom)} – {formatDate(new Date(new Date(row.periodTo).getTime() - 1))}</p></div> },
              { key: 'tripCount', label: 'Trips', align: 'right' },
              { key: 'total', label: 'Total', align: 'right', render: (row) => formatMoney(row.total) },
              { key: 'balanceDue', label: 'Due', align: 'right', render: (row) => formatMoney(row.balanceDue) },
              { key: 'dueDate', label: 'Due date', render: (row) => formatDate(row.dueDate) },
              { key: 'status', label: 'Status', render: (row) => <Badge value={row.status} /> },
              {
                key: 'actions',
                label: '',
                render: (row) => (
                  <div className="flex gap-2 justify-end">
                    <Button variant="secondary" onClick={() => downloadFile(`/corporate/invoices/${row._id}/pdf`, `${row.invoiceNumber.replace(/\W+/g, '_')}.pdf`).catch((err) => toast.error(errorMessage(err)))}><Download size={14} /> PDF</Button>
                    {row.balanceDue > 0 && <Button busy={busyId === row._id} onClick={() => pay(row)}><ExternalLink size={14} /> Pay online</Button>}
                    {row.paymentLink?.id && row.balanceDue > 0 && <Button variant="secondary" disabled={busyId === row._id} onClick={() => sync(row)}><RefreshCw size={14} /></Button>}
                  </div>
                ),
              },
            ]}
            rows={data.items}
          />
          <Pager page={data.page} total={data.total} limit={data.limit} onPage={setPage} />
        </>
      )}
      {outstanding?.ledger?.items?.length > 0 && (
        <Card className="p-5 mt-5">
          <h2 className="font-semibold text-gray-900 mb-3">Recent account activity</h2>
          <div className="space-y-2 text-sm">
            {outstanding.ledger.items.map((entry) => (
              <div key={entry._id} className="flex justify-between gap-3 border-b border-gray-50 pb-2">
                <div><p>{entry.description}</p><p className="text-xs text-gray-400">{formatDate(entry.createdAt, true)} · {entry.kind}</p></div>
                <p className={`tabular-nums font-medium ${entry.amount < 0 ? 'text-emerald-700' : 'text-gray-900'}`}>{entry.amount < 0 ? '−' : '+'}{formatMoney(Math.abs(entry.amount))}</p>
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
