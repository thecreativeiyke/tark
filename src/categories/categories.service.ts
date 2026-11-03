import {
  Injectable,
  OnModuleInit,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Category } from './entities/category.entity';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

const SEED_CATEGORIES = [
  { name: 'Plumbing & Pipefitting', slug: 'plumbing', icon: 'wrench' },
  { name: 'Electrical & Wiring', slug: 'electrical', icon: 'zap' },
  { name: 'Solar & Inverter Systems', slug: 'solar-inverter', icon: 'sun' },
  { name: 'Generator Mechanics', slug: 'generator-mechanic', icon: 'cpu' },
  { name: 'AC & Refrigeration', slug: 'ac-refrigeration', icon: 'thermometer' },
  { name: 'Carpentry & Woodwork', slug: 'carpentry', icon: 'tool' },
  { name: 'Painting & POP Ceiling', slug: 'painting-pop', icon: 'brush' },
  { name: 'Tiling & Masonry', slug: 'tiling-masonry', icon: 'grid' },
  { name: 'Aluminum & Welding', slug: 'welding-fabrication', icon: 'shield' },
  { name: 'Tailoring & Fashion Design', slug: 'tailoring', icon: 'scissors' },
];

@Injectable()
export class CategoriesService implements OnModuleInit {
  private readonly logger = new Logger(CategoriesService.name);

  constructor(
    @InjectRepository(Category)
    private categoryRepository: Repository<Category>,
  ) {}

  async onModuleInit() {
    const count = await this.categoryRepository.count();
    if (count === 0) {
      this.logger.log('Seeding default artisan categories into database...');
      await this.categoryRepository.save(SEED_CATEGORIES);
      this.logger.log('Categories seeded successfully.');
    }
  }

  findAllActive() {
    return this.categoryRepository.find({
      where: { isActive: true },
      order: { name: 'ASC' },
    });
  }

  findAll() {
    return this.categoryRepository.find({
      order: { name: 'ASC' },
    });
  }

  findBySlug(slug: string) {
    return this.categoryRepository.findOneBy({ slug, isActive: true });
  }

  async resolveCategory(input: string): Promise<Category | null> {
    if (!input) return null;
    const trimmed = input.trim();
    // 1. Try exact slug match
    const bySlug = await this.categoryRepository.findOneBy({
      slug: trimmed.toLowerCase(),
      isActive: true,
    });
    if (bySlug) return bySlug;

    // 2. Try case-insensitive name match
    return this.categoryRepository
      .createQueryBuilder('category')
      .where('LOWER(category.name) = LOWER(:name)', { name: trimmed })
      .andWhere('category.isActive = true')
      .getOne();
  }

  async create(dto: CreateCategoryDto) {
    const existing = await this.categoryRepository.findOne({
      where: [{ slug: dto.slug.toLowerCase() }, { name: dto.name }],
    });
    if (existing) {
      throw new BadRequestException('A category with this name or slug already exists');
    }
    const category = this.categoryRepository.create({
      ...dto,
      slug: dto.slug.toLowerCase(),
      isActive: true,
    });
    return this.categoryRepository.save(category);
  }

  async update(id: string, dto: UpdateCategoryDto) {
    const category = await this.categoryRepository.findOneBy({ id });
    if (!category) {
      throw new NotFoundException('Category not found');
    }
    if (dto.slug) dto.slug = dto.slug.toLowerCase();
    Object.assign(category, dto);
    return this.categoryRepository.save(category);
  }

  async remove(id: string) {
    const category = await this.categoryRepository.findOneBy({ id });
    if (!category) {
      throw new NotFoundException('Category not found');
    }
    category.isActive = false; // Soft-deactivate so existing historical jobs don't break
    return this.categoryRepository.save(category);
  }
}
