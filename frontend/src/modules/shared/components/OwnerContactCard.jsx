import React from 'react';
import { Mail, MapPin, MessageCircle, Phone, UserRound } from 'lucide-react';
import { useSupportInfo } from '../content/supportInfo';

/**
 * Who runs Connect Bharat and how to reach them, shown on the support and legal pages.
 * App stores check that these pages name the business behind the app, so the
 * owner, company, number and address are all spelled out here.
 */
export const OwnerContactCard = () => {
  const info = useSupportInfo();
  const initials = info.ownerName
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  const rows = [
    info.phone && { Icon: Phone, label: 'Phone', value: info.phone, href: `tel:${info.phoneHref}` },
    info.whatsapp && { Icon: MessageCircle, label: 'WhatsApp', value: info.whatsappDisplay, href: `https://wa.me/${info.whatsapp}` },
    info.email && { Icon: Mail, label: 'Email', value: info.email, href: `mailto:${info.email}` },
    info.officeAddress && { Icon: MapPin, label: 'Registered office', value: info.officeAddress },
  ].filter(Boolean);

  return (
    <div className="rounded-[28px] border border-stone-200 bg-white p-7 shadow-sm md:p-8">
      <div className="flex flex-col gap-6 md:flex-row md:items-start md:gap-10">
        <div className="flex items-center gap-4 md:w-72 md:shrink-0">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-[#f4b400] text-lg font-black text-black">
            {initials || <UserRound size={26} />}
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-black uppercase tracking-[0.24em] text-stone-400">Owner</p>
            {info.ownerName ? (
              <p className="mt-1 text-xl font-black leading-tight text-slate-900">{info.ownerName}</p>
            ) : null}
            {info.ownerRole ? (
              <p className="text-sm font-bold text-slate-500">{info.ownerRole}</p>
            ) : null}
            <p className="mt-1 text-sm font-bold text-slate-500">{info.companyName}</p>
          </div>
        </div>

        <div className="grid flex-1 gap-3 sm:grid-cols-2">
          {rows.map((row) => {
            const { label, value, href } = row;
            const body = (
              <>
                <row.Icon size={18} className="mt-0.5 shrink-0 text-[#c98f00]" />
                <span className="min-w-0">
                  <span className="block text-[11px] font-black uppercase tracking-[0.2em] text-stone-400">{label}</span>
                  <span className="block break-words text-sm font-bold text-slate-900">{value}</span>
                </span>
              </>
            );
            const className = 'flex items-start gap-3 rounded-2xl bg-slate-50 px-4 py-3';
            return href ? (
              <a key={label} href={href} target={href.startsWith('http') ? '_blank' : undefined} rel="noreferrer" className={`${className} transition hover:opacity-80`}>
                {body}
              </a>
            ) : (
              <div key={label} className={className}>{body}</div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

/** Plain question-and-answer list; native <details> so it needs no state. */
export const FaqList = ({ title, items }) => (
  <div>
    <h2 className="text-2xl font-black tracking-tight text-slate-900 md:text-3xl">{title}</h2>
    <div className="mt-6 space-y-3">
      {items.map((item) => (
        <details key={item.q} className="group rounded-2xl border border-stone-200 bg-white px-5 py-4 shadow-sm">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-base font-black text-slate-900">
            {item.q}
            <span className="text-xl leading-none text-[#c98f00] transition group-open:rotate-45">+</span>
          </summary>
          <p className="mt-3 text-sm font-medium leading-7 text-slate-600">{item.a}</p>
        </details>
      ))}
    </div>
  </div>
);
