// ===== GREEN EVERSHINE LIBRARY — app.js =====
// NOTE: Supabase credentials are injected here for GitHub Pages compatibility.
// For production with a proper build system, use environment variables.

// ── Config (injected at deploy time; keep secrets out of public repos if possible) ──
const SUPABASE_URL      = 'https://sblzihqudawabcauoyia.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNibHppaHF1ZGF3YWJjYXVveWlhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3MDQyNDIsImV4cCI6MjA5MzI4MDI0Mn0.7hTvQK0qpC2HJnBxNVB4bcCv85o2Qi2e12GbNpwovJg';

// ── Supabase client (loaded via CDN) ──
let supabase;

function initSupabase() {
  supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

// ── Month names ──
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── Auth guard ──
function requireAuth() {
  if (localStorage.getItem('gel_session') !== 'active') {
    window.location.href = 'login.html';
    return false;
  }
  return true;
}

function logout() {
  localStorage.removeItem('gel_session');
  localStorage.removeItem('gel_user');
  window.location.href = 'login.html';
}

// ── Toast notifications ──
function showToast(msg, type = 'default', duration = 3000) {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toastOut 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ── Years ──
async function getYears() {
  const { data, error } = await supabase
    .from('years')
    .select('*')
    .order('year', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function addYear(year) {
  const { error } = await supabase.from('years').insert({ year: parseInt(year) });
  if (error) throw error;
}

// ── Students ──
async function getStudents(year, search = '') {
  let query = supabase
    .from('students')
    .select('*')
    .eq('year', year)
    .order('created_at', { ascending: false });

  if (search) {
    query = query.or(`name.ilike.%${search}%,seat_number.ilike.%${search}%`);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function addStudent(studentData, photoFile) {
  let photo_url = null;

  if (photoFile) {
    const ext = photoFile.name.split('.').pop();
    const fileName = `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from('student-photos')
      .upload(fileName, photoFile, { cacheControl: '3600', upsert: false });
    if (uploadError) throw uploadError;

    const { data: urlData } = supabase.storage
      .from('student-photos')
      .getPublicUrl(fileName);
    photo_url = urlData.publicUrl;
  }

  const { data, error } = await supabase.from('students').insert({
    name:         studentData.name,
    address:      studentData.address,
    phone:        studentData.phone,
    seat_number:  studentData.seat_number,
    joining_date: studentData.joining_date,
    photo_url,
    year:         parseInt(studentData.year),
  }).select().single();

  if (error) throw error;

  // Create 12 payment records (unpaid by default)
  const paymentRows = MONTHS.map((_, i) => ({
    student_id: data.id,
    month:      i + 1,
    status:     'unpaid',
    year:       parseInt(studentData.year),
  }));
  const { error: payErr } = await supabase.from('payments').insert(paymentRows);
  if (payErr) throw payErr;

  return data;
}

async function getStudentPayments(studentId, year) {
  const { data, error } = await supabase
    .from('payments')
    .select('*')
    .eq('student_id', studentId)
    .eq('year', year)
    .order('month');
  if (error) throw error;
  return data || [];
}

async function markPayment(paymentId, studentId, month, year) {
  // Safety: check current status first (prevent reverting)
  const { data: existing } = await supabase
    .from('payments')
    .select('status')
    .eq('id', paymentId)
    .single();

  if (existing?.status === 'paid') {
    showToast('Payment already marked as paid — cannot revert.', 'error');
    return false;
  }

  const { error } = await supabase
    .from('payments')
    .update({ status: 'paid' })
    .eq('id', paymentId)
    .eq('status', 'unpaid'); // extra safety: only update if still unpaid

  if (error) throw error;
  return true;
}

// ── Copy students to new year ──
async function copyStudentsToNewYear(fromYear, toYear) {
  const students = await getStudents(fromYear);
  if (!students.length) return;

  await addYear(toYear);

  for (const s of students) {
    const { data: newStudent, error } = await supabase.from('students').insert({
      name:         s.name,
      address:      s.address,
      phone:        s.phone,
      seat_number:  s.seat_number,
      joining_date: s.joining_date,
      photo_url:    s.photo_url,
      year:         parseInt(toYear),
    }).select().single();

    if (error) continue;

    const paymentRows = MONTHS.map((_, i) => ({
      student_id: newStudent.id,
      month:      i + 1,
      status:     'unpaid',
      year:       parseInt(toYear),
    }));
    await supabase.from('payments').insert(paymentRows);
  }
}

// ── Seats ──
async function getSeats() {
  const { data, error } = await supabase.from('seats').select('*').order('seat_code');
  if (error) throw error;
  return data || [];
}

async function addSeat(seatCode) {
  const code = seatCode.trim().toUpperCase();
  const { error } = await supabase.from('seats').insert({ seat_code: code });
  if (error) throw error;
}

async function deleteSeat(id) {
  const { error } = await supabase.from('seats').delete().eq('id', id);
  if (error) throw error;
}

async function isSeatTaken(seatCode, excludeStudentId = null) {
  if (!seatCode) return false;
  const normalized = seatCode.trim().toUpperCase();
  let query = supabase.from('students').select('id, name').ilike('seat_number', normalized);
  if (excludeStudentId) query = query.neq('id', excludeStudentId);
  const { data } = await query;
  return (data && data.length > 0) ? data[0] : false;
}


function getPhotoUrl(url) {
  return url || null;
}

// ── Format date ──
function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ── Export to window ──
window.GEL = {
  initSupabase, requireAuth, logout, showToast,
  getYears, addYear, getStudents, addStudent,
  getStudentPayments, markPayment, copyStudentsToNewYear,
  getSeats, addSeat, deleteSeat, isSeatTaken,
  getPhotoUrl, formatDate,
  MONTHS,
};
