import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import toast from 'react-hot-toast';
import { corporateApi, errorMessage } from '../services/corporateApi';
import { Button, Card, ErrorNote, Loading, PageHeader, useLoad } from '../components/ui';
import TravelZoneEditor from '../components/TravelZoneEditor';
import { travelZoneToBody, travelZoneToForm, validateTravelZone } from '../components/helpers';

function TravelZoneForm({ zone, readOnly, onSaved }) {
  const [form, setForm] = useState(() => travelZoneToForm(zone));
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const problem = validateTravelZone(form);
    if (problem) {
      toast.error(problem);
      return;
    }
    setBusy(true);
    try {
      onSaved(await corporateApi.saveTravelZone(travelZoneToBody(form)));
      toast.success('Travel zone saved');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5 space-y-4">
      <TravelZoneEditor value={form} onChange={setForm} readOnly={readOnly} />
      {!readOnly && <div className="flex justify-end"><Button busy={busy} onClick={save}>Save travel zone</Button></div>}
    </Card>
  );
}

export default function CorporateTravelZone() {
  const { session } = useOutletContext() || {};
  const readOnly = !['owner', 'admin'].includes(session?.admin?.role);
  const { data, loading, error, setData } = useLoad(() => corporateApi.travelZone(), []);
  const [version, setVersion] = useState(0);

  return (
    <>
      <PageHeader
        title="Travel zone"
        subtitle="Let employees bill trips anywhere, or only around your offices. Checked when a trip is quoted and booked, from the app or the travel desk."
      />
      <ErrorNote message={error} />
      {loading ? <Loading /> : !error && (
        <TravelZoneForm
          key={version}
          zone={data}
          readOnly={readOnly}
          onSaved={(saved) => { setData(saved); setVersion((value) => value + 1); }}
        />
      )}
    </>
  );
}
