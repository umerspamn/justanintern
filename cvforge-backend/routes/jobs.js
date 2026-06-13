const express = require('express');
const router = express.Router();

router.get('/search', async (req, res) => {
    const { career, location = 'Pakistan' } = req.query;

    if (!career) {
        return res.status(400).json({ success: false, error: 'career is required' });
    }

    try {
        const response = await fetch(
            `https://jsearch.p.rapidapi.com/search?query=${encodeURIComponent(career + ' in ' + location)}&page=1&num_pages=2&date_posted=month`,
            {
                method: 'GET',
                headers: {
                   'x-rapidapi-key': process.env.RAPIDAPI_KEY, 
                   'x-rapidapi-host': 'jsearch.p.rapidapi.com'
                }
            }
        );

        const data = await response.json();

        const jobs = data.data?.map(job => ({
            title:         job.job_title,
            company:       job.employer_name,
            location:      job.job_city ? `${job.job_city}, ${job.job_country}` : job.job_country,
            type:          job.job_employment_type,
            remote:        job.job_is_remote,
            salary_min:    job.job_min_salary,
            salary_max:    job.job_max_salary,
            salary_period: job.job_salary_period,
            posted:        job.job_posted_at_datetime_utc,
            apply_link:    job.job_apply_link,
            description:   job.job_description?.slice(0, 400) + '...',
            logo:          job.employer_logo,
            publisher:     job.job_publisher
        })) || [];

        res.json({ success: true, jobs, total: jobs.length });

    } catch (err) {
        console.error('[Jobs] Search error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;