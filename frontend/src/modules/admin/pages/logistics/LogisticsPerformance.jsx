import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import AdminPageHeader from '../../components/ui/AdminPageHeader';
import { logisticsAdminService as service, plain } from '../../services/logisticsAdminService';
import { Card, Empty, Field } from '../../../hub/components/ui';
import { inputClass } from '../../../hub/components/format';

/** Admin: hub league table, ranked on SLA breach, failed-delivery rate, throughput. */
const isoDay = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

const LogisticsPerformance = () => {
  const [from, setFrom] = useState(isoDay(-29));
  const [to, setTo] = useState(isoDay(0));
  const [rows, setRows] = useState([]);

  const load = useCallback(() => {
    service.leagueTable({ from, to }).then((data) => setRows(plain(data?.results || []))).catch((error) => toast.error(error.message));
  }, [from, to]);
  useEffect(load, [load]);

  return (
    <div className="p-6 lg:p-8 space-y-5">
      <AdminPageHeader
        module="Parcel network"
        page="Hub performance"
        title="Hub performance"
        right={
          <div className="flex gap-2">
            <Field label="From"><input type="date" className={inputClass} value={from} onChange={(event) => setFrom(event.target.value)} /></Field>
            <Field label="To"><input type="date" className={inputClass} value={to} onChange={(event) => setTo(event.target.value)} /></Field>
          </div>
        }
      />
      <Card>
        {rows.length ? (
          <div className="overflow-x-auto -mx-4">
            <table className="w-full text-[13px] tabular-nums">
              <thead>
                <tr className="text-left text-[11px] uppercase text-slate-400 border-b border-slate-100">
                  {['#', 'Hub', 'Inbound', 'Outbound', 'Delivered', 'Failed %', 'SLA breach %', 'Avg dwell h', 'On shelf', 'Scan compliance %'].map((label) => (
                    <th key={label} className="px-4 py-2 font-medium">{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.hubId} className="border-b border-slate-50">
                    <td className="px-4 py-2">{row.rank}</td>
                    <td className="px-4 py-2"><span className="font-mono">{row.hub?.code}</span> <span className="text-slate-500">{row.hub?.name}</span></td>
                    <td className="px-4 py-2">{row.throughput.inbound}</td>
                    <td className="px-4 py-2">{row.throughput.outbound}</td>
                    <td className="px-4 py-2">{row.throughput.delivered}</td>
                    <td className="px-4 py-2">{row.failedDeliveryPercent}</td>
                    <td className={`px-4 py-2 ${row.sla.percent > 10 ? 'text-rose-700' : ''}`}>{row.sla.percent} <span className="text-slate-400">({row.sla.breached}/{row.sla.measured})</span></td>
                    <td className="px-4 py-2">{row.dwell.averageHours}</td>
                    <td className="px-4 py-2">{row.dwell.onShelf}</td>
                    <td className="px-4 py-2">{row.scanCompliance.percent}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No active hubs.</Empty>
        )}
      </Card>
    </div>
  );
};

export default LogisticsPerformance;
