import { useCallback, useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Download } from 'lucide-react';
import { hubApi, openBlob } from '../services/hubApi';
import { Button, Card, Field, PageTitle, Stat } from '../components/ui';
import { inputClass, money } from '../components/format';

const isoDay = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

/** Daily revenue (managers only) and hub performance for a date range. */
const HubReports = () => {
  const { me } = useOutletContext() || {};
  const isManager = me?.staff?.role === 'hub_manager';
  const [from, setFrom] = useState(isoDay(-6));
  const [to, setTo] = useState(isoDay(0));
  const [revenue, setRevenue] = useState(null);
  const [performance, setPerformance] = useState(null);

  const load = useCallback(() => {
    hubApi.performance({ from, to }).then(setPerformance).catch((error) => toast.error(error.message));
    if (isManager) hubApi.revenue({ from, to }).then(setRevenue).catch((error) => toast.error(error.message));
  }, [from, to, isManager]);
  useEffect(load, [load]);

  const downloadCsv = async () => {
    try {
      const blob = await hubApi.revenueCsv({ from, to });
      openBlob(blob, `hub-revenue-${from}-to-${to}.csv`, { download: true });
    } catch (error) {
      toast.error(error.message);
    }
  };

  return (
    <div className="space-y-5">
      <PageTitle
        title="Reports"
        right={
          <div className="flex items-end gap-2">
            <Field label="From"><input type="date" className={inputClass} value={from} onChange={(event) => setFrom(event.target.value)} /></Field>
            <Field label="To"><input type="date" className={inputClass} value={to} onChange={(event) => setTo(event.target.value)} /></Field>
          </div>
        }
      />
      {performance && (
        <Card title="Performance">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Inbound scans" value={performance.throughput.inbound} />
            <Stat label="Outbound scans" value={performance.throughput.outbound} />
            <Stat label="Delivered" value={performance.throughput.delivered} tone="text-emerald-700" />
            <Stat label="Failed attempts" value={performance.throughput.failed} tone="text-rose-700" />
            <Stat label="Avg dwell" value={`${performance.dwell.averageHours} h`} hint={`median ${performance.dwell.medianHours} h · ${performance.dwell.onShelf} on shelf`} />
            <Stat label="SLA breach" value={`${performance.sla.percent}%`} hint={`${performance.sla.breached} of ${performance.sla.measured}`} />
            <Stat label="Failed delivery" value={`${performance.failedDeliveryPercent}%`} />
            <Stat label="Scan compliance" value={`${performance.scanCompliance.percent}%`} hint={`${performance.scanCompliance.compliant} of ${performance.scanCompliance.departed}`} />
          </div>
        </Card>
      )}
      {isManager && revenue && (
        <Card title="Daily revenue (shipments booked through this hub)" right={<Button variant="secondary" onClick={downloadCsv}><Download size={14} /> CSV</Button>}>
          <div className="overflow-x-auto -mx-4">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400 border-b border-slate-100">
                  {['Date', 'Shipments', 'Revenue', 'Tax', 'Insurance', 'Prepaid', 'Cash', 'COD booked', 'COD collected', 'Kg'].map((label) => <th key={label} className="px-4 py-2 font-medium">{label}</th>)}
                </tr>
              </thead>
              <tbody>
                {[...revenue.rows, { ...revenue.totals, date: 'Total' }].map((row) => (
                  <tr key={row.date} className={`border-b border-slate-50 tabular-nums ${row.date === 'Total' ? 'font-semibold' : ''}`}>
                    <td className="px-4 py-2">{row.date}</td>
                    <td className="px-4 py-2">{row.shipments}</td>
                    <td className="px-4 py-2">{money(row.revenue)}</td>
                    <td className="px-4 py-2">{money(row.tax)}</td>
                    <td className="px-4 py-2">{money(row.insurance)}</td>
                    <td className="px-4 py-2">{money(row.prepaid)}</td>
                    <td className="px-4 py-2">{money(row.cashAtPickup)}</td>
                    <td className="px-4 py-2">{money(row.codBooked)}</td>
                    <td className="px-4 py-2">{money(row.codCollected)}</td>
                    <td className="px-4 py-2">{row.chargeableKg}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {!isManager && <p className="text-[12px] text-slate-400">Revenue is visible to hub managers.</p>}
    </div>
  );
};

export default HubReports;
